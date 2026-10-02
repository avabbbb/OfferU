use std::io;
use std::process::{Child, Command};

pub(crate) struct ProcessTree {
    child: Child,
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl ProcessTree {
    pub(crate) fn spawn(mut command: Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;

            const CREATE_SUSPENDED: u32 = 0x00000004;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let job = WindowsJob::new()?;
            command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
            let child = command.spawn()?;
            let mut tree = Self {
                child,
                job: Some(job),
            };

            let assigned = tree
                .job
                .as_ref()
                .expect("new process tree has a job")
                .assign(&tree.child);
            if let Err(error) = assigned {
                tree.terminate();
                return Err(error);
            }
            if let Err(error) = resume_primary_thread(tree.child.id()) {
                tree.terminate();
                return Err(error);
            }
            Ok(tree)
        }

        #[cfg(not(windows))]
        {
            let child = command.spawn()?;
            Ok(Self { child })
        }
    }

    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub(crate) fn terminate(&mut self) {
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            if let Err(error) = job.terminate() {
                eprintln!("[OfferU] TerminateJobObject failed: {error}");
            }
            // Closing the last kill-on-close handle is the force-kill fallback.
            drop(job);
        }

        if self.is_alive() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(windows)]
struct WindowsJob(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl WindowsJob {
    fn new() -> io::Result<Self> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut limits = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(raw) };
            return Err(error);
        }

        Ok(Self(unsafe { OwnedHandle::from_raw_handle(raw) }))
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let assigned =
            unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) };
        if assigned == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn terminate(&self) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        let terminated = unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) };
        if terminated == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn resume_primary_thread(process_id: u32) -> io::Result<()> {
    use std::mem;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let snapshot_raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot_raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot_raw) };
    let mut entry = unsafe { mem::zeroed::<THREADENTRY32>() };
    entry.dwSize = mem::size_of::<THREADENTRY32>() as u32;
    if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut primary_thread_id = None;
    loop {
        if entry.th32OwnerProcessID == process_id {
            primary_thread_id = Some(entry.th32ThreadID);
            break;
        }
        if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
            break;
        }
    }
    let thread_id = primary_thread_id.ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "suspended child thread not found")
    })?;
    let thread_raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread_raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    let thread = unsafe { OwnedHandle::from_raw_handle(thread_raw) };
    let previous_suspend_count = unsafe { ResumeThread(thread.as_raw_handle()) };
    if previous_suspend_count == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    if previous_suspend_count == 0 {
        return Err(io::Error::other("child main thread was not suspended"));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::ProcessTree;
    use std::net::{TcpListener, TcpStream};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const FIXTURE_ENV: &str = "OFFERU_LIFECYCLE_FIXTURE";
    const PORT_ENV: &str = "OFFERU_LIFECYCLE_TEST_PORT";

    fn fixture_command(role: &str, port: u16) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process_lifecycle::tests::process_fixture",
                "--nocapture",
            ])
            .env(FIXTURE_ENV, role)
            .env(PORT_ENV, port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[test]
    fn process_fixture() {
        match std::env::var(FIXTURE_ENV).as_deref() {
            Ok("owner") => {
                let port = std::env::var(PORT_ENV).unwrap().parse::<u16>().unwrap();
                let _listener_tree = ProcessTree::spawn(fixture_command("listener", port)).unwrap();
                assert!(
                    wait_for_port(port, true),
                    "owned listener never became ready"
                );
                loop {
                    std::thread::park();
                }
            }
            Ok("listener") => {
                let port = std::env::var(PORT_ENV).unwrap().parse::<u16>().unwrap();
                let _listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
                loop {
                    std::thread::park();
                }
            }
            _ => {}
        }
    }

    fn unused_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    fn can_connect(port: u16) -> bool {
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(100),
        )
        .is_ok()
    }

    fn wait_for_port(port: u16, expected: bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if can_connect(port) == expected {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn normal_close_kills_owned_grandchild_and_preserves_unrelated_listener() {
        let unrelated = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let unrelated_port = unrelated.local_addr().unwrap().port();
        let owned_port = unused_port();
        let owner = ProcessTree::spawn(fixture_command("owner", owned_port)).unwrap();

        assert!(
            wait_for_port(owned_port, true),
            "descendant listener never became ready"
        );
        drop(owner);

        assert!(
            wait_for_port(owned_port, false),
            "owned descendant still holds its port"
        );
        assert!(
            can_connect(unrelated_port),
            "unrelated service was terminated"
        );
    }

    #[test]
    fn hard_kill_of_job_owner_releases_descendant_listener() {
        let owned_port = unused_port();
        let mut owner = fixture_command("owner", owned_port).spawn().unwrap();

        assert!(
            wait_for_port(owned_port, true),
            "descendant listener never became ready"
        );
        owner.kill().unwrap();
        owner.wait().unwrap();

        assert!(
            wait_for_port(owned_port, false),
            "descendant survived hard owner termination"
        );
    }
}

use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct StderrObservation {
    pub(crate) bytes: usize,
    pub(crate) markers: Vec<&'static str>,
}

impl StderrObservation {
    fn observe(&mut self, bytes: &[u8]) {
        self.bytes = self.bytes.saturating_add(bytes.len());
        // Only fixed diagnostic markers leave the reader; arbitrary stderr can
        // contain credentials, paths or career data and is never logged.
        for marker in [
            "ModuleNotFoundError",
            "ImportError",
            "PermissionError",
            "OperationalError",
            "IntegrityError",
            "RuntimeError",
            "ValidationError",
            "Failed to load Python DLL",
            "Failed to execute script",
            "Address already in use",
        ] {
            if bytes
                .windows(marker.len())
                .any(|part| part == marker.as_bytes())
                && !self.markers.contains(&marker)
            {
                self.markers.push(marker);
            }
        }
    }
}

fn drain_stderr(child: &mut Child) -> Arc<Mutex<StderrObservation>> {
    let observation = Arc::new(Mutex::new(StderrObservation::default()));
    if let Some(mut stderr) = child.stderr.take() {
        let shared = observation.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buffer = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if let Ok(mut value) = shared.lock() {
                    value.observe(&buffer[..count]);
                }
            }
        });
    }
    observation
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessState {
    Running,
    Exited(Option<i32>),
    WaitError(io::ErrorKind),
}

impl ProcessState {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited(_) => "exited",
            Self::WaitError(_) => "wait_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessSnapshot {
    pub(crate) pid: u32,
    pub(crate) state: ProcessState,
    pub(crate) job_active_process_count_snapshot: Option<u32>,
    pub(crate) job_live_process_ids: Option<Vec<u32>>,
    pub(crate) job_query_error_kind: Option<io::ErrorKind>,
    pub(crate) stderr: StderrObservation,
}

fn classify_wait_result(wait: Result<Option<ExitStatus>, io::ErrorKind>) -> ProcessState {
    match wait {
        Ok(None) => ProcessState::Running,
        Ok(Some(status)) => ProcessState::Exited(status.code()),
        Err(kind) => ProcessState::WaitError(kind),
    }
}

#[cfg(windows)]
fn process_id_is_running(process_id: u32) -> io::Result<bool> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    match wait {
        WAIT_OBJECT_0 => Ok(false),
        WAIT_TIMEOUT => Ok(true),
        _ => Err(io::Error::last_os_error()),
    }
}

pub(crate) struct ProcessTree {
    child: Child,
    stderr: Arc<Mutex<StderrObservation>>,
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
            let mut child = command.spawn()?;
            let stderr = drain_stderr(&mut child);
            let mut tree = Self {
                child,
                stderr,
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
            let mut child = command.spawn()?;
            let stderr = drain_stderr(&mut child);
            Ok(Self { child, stderr })
        }
    }

    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub(crate) fn snapshot(&mut self) -> ProcessSnapshot {
        let pid = self.child.id();
        let state = classify_wait_result(self.child.try_wait().map_err(|error| error.kind()));
        #[cfg(windows)]
        let (job_active_process_count_snapshot, job_live_process_ids, job_query_error_kind) = self
            .job
            .as_ref()
            .map(|job| match job.process_snapshot() {
                Ok((count, pids)) => (Some(count), Some(pids), None),
                Err(error) => (None, None, Some(error.kind())),
            })
            .unwrap_or((None, None, None));
        #[cfg(not(windows))]
        let (job_active_process_count_snapshot, job_live_process_ids, job_query_error_kind) =
            (None, None, None);

        ProcessSnapshot {
            pid,
            state,
            job_active_process_count_snapshot,
            job_live_process_ids,
            job_query_error_kind,
            stderr: self
                .stderr
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default(),
        }
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

    fn process_snapshot(&self) -> io::Result<(u32, Vec<u32>)> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
            QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_BASIC_PROCESS_ID_LIST,
        };

        let mut information =
            unsafe { std::mem::zeroed::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                &mut information as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of_val(&information) as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(io::Error::last_os_error());
        }
        let capacity = (information.ActiveProcesses as usize).max(1);
        let list_bytes = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
            + (capacity - 1) * std::mem::size_of::<usize>();
        let mut storage = vec![0usize; list_bytes.div_ceil(std::mem::size_of::<usize>())];
        let queried = unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicProcessIdList,
                storage.as_mut_ptr().cast(),
                list_bytes as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(io::Error::last_os_error());
        }
        let list = storage.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        let count = unsafe { (*list).NumberOfProcessIdsInList as usize };
        if count > capacity {
            return Err(io::Error::other(
                "job process list exceeded its reported capacity",
            ));
        }
        let process_ids: Vec<u32> = unsafe {
            std::slice::from_raw_parts(
                std::ptr::addr_of!((*list).ProcessIdList).cast::<usize>(),
                count,
            )
        }
        .iter()
        .map(|process_id| *process_id as u32)
        .collect();
        let live_process_ids = process_ids
            .into_iter()
            .filter_map(|process_id| match process_id_is_running(process_id) {
                Ok(true) => Some(Ok(process_id)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<io::Result<Vec<_>>>()?;
        Ok((information.ActiveProcesses, live_process_ids))
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
    use super::{classify_wait_result, ProcessState, ProcessTree, StderrObservation};
    use std::io;
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
            Ok("handoff_owner") => {
                let port = std::env::var(PORT_ENV).unwrap().parse::<u16>().unwrap();
                let _payload = fixture_command("listener", port).spawn().unwrap();
                assert!(
                    wait_for_port(port, true),
                    "handoff payload listener never became ready"
                );
                std::process::exit(37);
            }
            Ok("exit") => std::process::exit(23),
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

    fn process_id_is_alive(process_id: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
        if handle.is_null() {
            return false;
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        unsafe { CloseHandle(handle) };
        wait == WAIT_TIMEOUT
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
    fn stderr_observation_keeps_only_fixed_markers_and_count() {
        let text = b"OperationalError: secret=synthetic-private-token person@example.test H:/private/resume.pdf";
        let mut observation = StderrObservation::default();
        observation.observe(text);
        observation.observe(text);
        assert_eq!(observation.bytes, text.len() * 2);
        assert_eq!(observation.markers, vec!["OperationalError"]);
        let diagnostic = format!("{observation:?}");
        assert!(!diagnostic.contains("synthetic-private-token"));
        assert!(!diagnostic.contains("person@"));
        assert!(!diagnostic.contains("resume.pdf"));
    }

    #[test]
    fn wait_result_classifies_running_and_wait_errors_without_error_text() {
        assert_eq!(classify_wait_result(Ok(None)), ProcessState::Running);
        assert_eq!(
            classify_wait_result(Err(io::ErrorKind::PermissionDenied)),
            ProcessState::WaitError(io::ErrorKind::PermissionDenied)
        );
    }

    #[test]
    fn exited_child_snapshot_records_exit_code_and_empty_job() {
        let mut process = ProcessTree::spawn(fixture_command("exit", unused_port())).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        let snapshot = loop {
            let snapshot = process.snapshot();
            if snapshot.state != ProcessState::Running {
                break snapshot;
            }
            assert!(Instant::now() < deadline, "fixture process did not exit");
            std::thread::sleep(Duration::from_millis(25));
        };

        assert_eq!(snapshot.pid, process.child.id());
        assert_eq!(snapshot.state, ProcessState::Exited(Some(23)));
        assert!(snapshot.job_live_process_ids.as_ref().unwrap().is_empty());
        assert_eq!(snapshot.job_query_error_kind, None);
    }

    #[test]
    fn exited_bootstrap_with_live_payload_is_distinguished_and_still_owned() {
        let port = unused_port();
        let mut process = ProcessTree::spawn(fixture_command("handoff_owner", port)).unwrap();
        assert!(
            wait_for_port(port, true),
            "payload listener never became ready"
        );

        let deadline = Instant::now() + Duration::from_secs(8);
        let snapshot = loop {
            let snapshot = process.snapshot();
            if snapshot.state != ProcessState::Running {
                break snapshot;
            }
            assert!(Instant::now() < deadline, "bootstrap process did not exit");
            std::thread::sleep(Duration::from_millis(25));
        };

        assert_eq!(snapshot.state, ProcessState::Exited(Some(37)));
        let payload_ids: Vec<u32> = snapshot
            .job_live_process_ids
            .as_ref()
            .expect("owned Job process list should be queryable")
            .iter()
            .copied()
            .filter(|process_id| *process_id != snapshot.pid)
            .collect();
        assert!(!payload_ids.is_empty());
        assert!(payload_ids
            .iter()
            .all(|process_id| process_id_is_alive(*process_id)));
        assert!(
            can_connect(port),
            "owned payload stopped with its bootstrap"
        );
        drop(process);
        assert!(
            wait_for_port(port, false),
            "owned payload survived job close"
        );
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

"use client";

import { PageHeader } from "@/components/layout/PageHeader";
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  Button,
  Card,
  CardBody,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tab,
  Tabs,
  Input,
  useDisclosure,
} from "@heroui/react";
import { Calendar as CalendarIcon, List, Plus, Sparkles } from "lucide-react";
import { createCalendarEvent, useCalendarEvents } from "@/lib/hooks";
import {
  bauhausFieldClassNames,
  bauhausModalContentClassName,
  bauhausTabsClassNames,
} from "@/lib/bauhaus";
import CascadeDatePicker from "./components/CascadeDatePicker";
import CascadeTimePicker from "./components/CascadeTimePicker";

const FullCalendar = dynamic(() => import("@fullcalendar/react"), { ssr: false });
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";

export default function CalendarPage() {
  const { data: events, mutate } = useCalendarEvents();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [viewMode, setViewMode] = useState<string>("calendar");
  const [newEvent, setNewEvent] = useState({
    title: "",
    description: "",
    start_time: "",
    end_time: "",
    location: "",
  });
  const [createError, setCreateError] = useState("");

  const calendarEvents = useMemo(() => {
    if (!events) return [];
    return events.map((event) => ({
      id: String(event.id),
      title: event.title,
      start: event.start_time,
      end: event.end_time || undefined,
      backgroundColor:
        event.event_type === "interview"
          ? "#e4ece6"
          : event.event_type === "deadline"
            ? "#f7ece9"
            : "#f3ead2",
      borderColor: "#121212",
      textColor: "#121212",
      extendedProps: {
        location: event.location,
        description: event.description,
        event_type: event.event_type,
      },
    }));
  }, [events]);

  const handleDateClick = (info: { dateStr: string }) => {
    setNewEvent((prev) => ({ ...prev, start_time: `${info.dateStr}T09:00` }));
    onOpen();
  };

  const handleCreate = async () => {
    if (!newEvent.title || !newEvent.start_time) return;
    setCreateError("");
    try {
      await createCalendarEvent({
        ...newEvent,
        start_time: new Date(newEvent.start_time).toISOString(),
        end_time: newEvent.end_time ? new Date(newEvent.end_time).toISOString() : null,
        event_type: "interview",
      });
      setNewEvent({ title: "", description: "", start_time: "", end_time: "", location: "" });
      onClose();
      mutate();
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "创建日程失败，请稍后重试"
      );
    }
  };

  const typeTone = (type: string) => {
    switch (type) {
      case "interview":
        return "bg-[var(--surface-muted)] text-[var(--foreground)]";
      case "deadline":
        return "bg-[var(--status-blush)] text-[var(--foreground)]";
      default:
        return "bg-[var(--surface-muted)] text-[var(--foreground)]";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="space-y-8"
    >
      <PageHeader title="日程" description="笔试、面试和截止日期都在这里。" />

      <section className="flex flex-wrap items-center justify-between gap-4">
        <Tabs
          size="sm"
          selectedKey={viewMode}
          onSelectionChange={(key) => setViewMode(key as string)}
          classNames={bauhausTabsClassNames}
        >
          <Tab key="calendar" title={<span className="inline-flex items-center gap-2"><CalendarIcon size={14} /> 日历</span>} />
          <Tab key="list" title={<span className="inline-flex items-center gap-2"><List size={14} /> 列表</span>} />
        </Tabs>

        <div className="flex flex-wrap gap-2">
          <Button startContent={<Sparkles size={16} />} className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]">
            AI 自动填充
          </Button>
          <Button startContent={<Plus size={16} />} onPress={onOpen} className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]">
            添加日程
          </Button>
        </div>
      </section>

      {viewMode === "calendar" && (
        <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none">
          <CardBody className="fullcalendar-dark p-4 md:p-5">
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: "dayGridMonth,timeGridWeek,timeGridDay",
              }}
              events={calendarEvents}
              dateClick={handleDateClick}
              height="auto"
              locale="zh-cn"
              buttonText={{ today: "今天", month: "月", week: "周", day: "日" }}
            />
          </CardBody>
        </Card>
      )}

      {viewMode === "list" && (
        events && events.length > 0 ? (
          <div className="space-y-4">
            {events.map((event) => (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.24, ease: "easeOut" }}
              >
                <Card className="bauhaus-panel rounded-none bg-white shadow-none">
                  <CardBody className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between">
                    <div className="flex items-start gap-4">
                      <div className={`bauhaus-panel-sm flex h-12 w-12 items-center justify-center ${typeTone(event.event_type)}`}>
                        <CalendarIcon size={18} />
                      </div>
                      <div>
                        <p className="text-xl font-semibold tracking-[-0.04em] text-[var(--foreground)]">{event.title}</p>
                        <p className="mt-2 text-sm font-medium text-[var(--foreground-muted)]">
                          {new Date(event.start_time).toLocaleString("zh-CN")}
                          {event.location && ` · ${event.location}`}
                        </p>
                        {event.description && (
                          <p className="mt-3 max-w-3xl text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                            {event.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardBody>
                </Card>
              </motion.div>
            ))}
          </div>
        ) : (
          <Card className="bauhaus-panel rounded-none bg-[var(--surface-muted)] text-[var(--foreground)] shadow-none">
            <CardBody className="p-10 text-center">
              <CalendarIcon size={54} className="mx-auto text-[var(--foreground-muted)]" />
              <p className="mt-4 text-lg font-semibold">暂无日程</p>
              <p className="mt-3 text-sm font-medium text-[var(--foreground-muted)]">
                点击「添加日程」或使用 AI 自动填充，把面试和截止时间收拢进这块时间板。
              </p>
            </CardBody>
          </Card>
        )
      )}

      <Modal isOpen={isOpen} onClose={onClose} placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border-strong)]/12 bg-[var(--surface-muted)] px-6 py-5 text-xl font-semibold tracking-[-0.06em]">
            添加日程
          </ModalHeader>
          <ModalBody className="space-y-3 px-6 py-6">
            {createError && (
              <p className="text-sm font-medium text-red-600" role="alert">{createError}</p>
            )}
            <Input label="标题" variant="bordered" value={newEvent.title} onValueChange={(v) => setNewEvent((p) => ({ ...p, title: v }))} classNames={bauhausFieldClassNames} />
            <div className="grid gap-3 md:grid-cols-2">
              <CascadeDatePicker
                label="开始日期"
                value={newEvent.start_time}
                onChange={(v) => setNewEvent((p) => ({ ...p, start_time: v }))}
              />
              <CascadeTimePicker
                label="开始时分"
                value={newEvent.start_time}
                onChange={(v) => setNewEvent((p) => ({ ...p, start_time: v }))}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <CascadeDatePicker
                label="结束日期"
                value={newEvent.end_time}
                onChange={(v) => setNewEvent((p) => ({ ...p, end_time: v }))}
              />
              <CascadeTimePicker
                label="结束时分"
                value={newEvent.end_time}
                onChange={(v) => setNewEvent((p) => ({ ...p, end_time: v }))}
              />
            </div>
            <Input label="地点" variant="bordered" value={newEvent.location} onValueChange={(v) => setNewEvent((p) => ({ ...p, location: v }))} classNames={bauhausFieldClassNames} />
            <Input label="描述" variant="bordered" value={newEvent.description} onValueChange={(v) => setNewEvent((p) => ({ ...p, description: v }))} classNames={bauhausFieldClassNames} />
          </ModalBody>
          <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={onClose} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
              取消
            </Button>
            <Button onPress={handleCreate} className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]">
              创建
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}

"use client";

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch } from "@nextui-org/react";
import { RefreshCcw } from "lucide-react";

interface ArchiveSettingsDialogProps {
  open: boolean;
  autoSyncEnabled: boolean;
  onClose: () => void;
  onAutoSyncChange: (next: boolean) => void;
  onOneClickSync: () => void;
  syncing: boolean;
}

export default function ArchiveSettingsDialog(props: ArchiveSettingsDialogProps) {
  return (
    <Modal isOpen={props.open} onClose={props.onClose} placement="center">
      <ModalContent className="border border-[var(--border-strong)]/15 bg-[var(--surface)] text-[var(--foreground)] shadow-[2px_2px_0_0_rgba(18,18,18,0.14)]">
        <ModalHeader className="border-b border-[var(--border-strong)]/15 px-6 py-5 text-xl font-semibold">
          同步设置
        </ModalHeader>
        <ModalBody className="space-y-5 px-6 py-6">
          <div className="space-y-2">
            <div className="text-sm font-semibold text-[var(--foreground)]">保持简历档案与投递档案同步</div>
            <p className="text-xs leading-relaxed text-[var(--foreground-muted)]">
              开启后，简历档案中的共享字段变化时，会自动同步到投递档案中的对应字段。
            </p>
            <Switch isSelected={props.autoSyncEnabled} onValueChange={props.onAutoSyncChange}>
              {props.autoSyncEnabled ? "已开启" : "已关闭"}
            </Switch>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-[var(--foreground)]">一键同步到投递档案</div>
            <p className="text-xs leading-relaxed text-[var(--foreground-muted)]">
              将当前简历档案中的共享字段立即同步到投递档案。手动覆盖过的字段会按同步设置处理。
            </p>
            <Button
              startContent={<RefreshCcw size={14} />}
              isLoading={props.syncing}
              className="bauhaus-button bauhaus-button-blue !px-4 !py-2 !text-[11px]"
              onPress={props.onOneClickSync}
            >
              一键同步到投递档案
            </Button>
          </div>
        </ModalBody>
        <ModalFooter className="border-t border-[var(--border-strong)]/15 px-6 py-5">
          <Button
            className="bauhaus-button bauhaus-button-outline !px-4 !py-2 !text-[11px]"
            onPress={props.onClose}
          >
            关闭
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

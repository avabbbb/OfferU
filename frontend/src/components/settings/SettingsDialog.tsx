"use client";

import type { ReactNode } from "react";
import { Modal, ModalBody, ModalContent, ModalHeader } from "@heroui/react";

export function SettingsDialog({
  isOpen,
  onClose,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" placement="center" scrollBehavior="inside">
      <ModalContent className="max-h-[88vh] ou-sheet bg-[var(--ou-bg-surface-solid)] text-[var(--ou-text-primary)]">
        <ModalHeader className="px-6 py-4 text-lg font-semibold">{title}</ModalHeader>
        <ModalBody className="space-y-5 overflow-y-auto px-6 py-5">{children}</ModalBody>
      </ModalContent>
    </Modal>
  );
}

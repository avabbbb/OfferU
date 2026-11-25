"use client";

import { useParams } from "next/navigation";
import { motion } from "framer-motion";

import { JobDetail } from "@/components/jobs/JobDetail";

// 岗位详情整页（深链 #/jobs/:id）：阅读宽度单栏，顶上一条玻璃返回栏。内容见 components/jobs/JobDetail。
export default function JobDetailPage() {
  const id = Number(useParams().id);
  return (
    <motion.div className="jb jb-detail-page ou-page-reading" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}
      transition={{ x: { type: "spring", stiffness: 380, damping: 38, mass: 0.9 }, opacity: { duration: 0.2 } }}>
      <JobDetail key={id} id={id} mode="page" />
    </motion.div>
  );
}

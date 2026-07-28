"use client";

import { motion } from "framer-motion";

const pageVariants = {
  hidden: { opacity: 0, y: 12, scale: 0.995 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.32,
      ease: [0.18, 0.89, 0.32, 1.15],
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    scale: 0.995,
    transition: {
      duration: 0.18,
      ease: [0.2, 0.85, 0.25, 1],
    },
  },
};

export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      variants={pageVariants}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}

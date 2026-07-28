import { redirect } from "next/navigation";

// ADR 0031/0033:独立 agent 页面取消,主 Agent 由右侧上下文栏 "OfferU" 模式承接。
export default function AgentPage() {
  redirect("/");
}

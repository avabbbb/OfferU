import { redirect } from "next/navigation";

// ADR 0033:统计与趋势并入"今日"按需展开,不再作为一级页面。
export default function AnalyticsPage() {
  redirect("/");
}

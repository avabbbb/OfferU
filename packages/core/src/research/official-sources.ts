// Which job URLs count as the company's own recruiting system.
// Port of the domain tables + official_kind() from Python app/core/job_sources.py.
// The "find the posting on the official site" fetcher in that file belongs to
// job intake (add_job) and is not ported here.

import { hostnameOf } from "./py";

/** Company → its own recruiting domains (subdomains included). */
export const OFFICIAL_DOMAINS: Record<string, readonly string[]> = {
  "腾讯": ["careers.tencent.com", "join.qq.com"],
  "百度": ["talent.baidu.com"],
  "字节跳动": ["jobs.bytedance.com", "job.toutiao.com"],
  "阿里巴巴": ["talent.alibaba.com", "careers.alibaba.com", "talent-holding.alibaba.com"],
  "蚂蚁": ["talent.antgroup.com"],
  "美团": ["zhaopin.meituan.com"],
  "京东": ["zhaopin.jd.com", "campus.jd.com"],
  "快手": ["zhaopin.kuaishou.cn", "campus.kuaishou.cn"],
  "网易": ["hr.163.com"],
  "小米": ["hr.xiaomi.com"],
  "华为": ["career.huawei.com"],
  "拼多多": ["careers.pddglobalhr.com"],
  "哔哩哔哩": ["jobs.bilibili.com"],
};

/** Hosted ATS a company opens itself: the domain is not the company's, the page must name it. */
export const HOSTED_ATS: readonly string[] = [
  "mokahr.com", "jobs.feishu.cn", "zhiye.com", "hotjob.cn", "greenhouse.io", "lever.co",
  "myworkdayjobs.com", "ashbyhq.com", "smartrecruiters.com",
];

function hostIn(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** "own": company's own recruiting domain; "ats": hosted ATS; "": not official. */
export function officialKind(url: string, company: string): "own" | "ats" | "" {
  const host = hostnameOf(url);
  if (!host) return "";
  if (company && Object.hasOwn(OFFICIAL_DOMAINS, company) && hostIn(host, OFFICIAL_DOMAINS[company])) return "own";
  if (hostIn(host, HOSTED_ATS)) return "ats";
  return "";
}

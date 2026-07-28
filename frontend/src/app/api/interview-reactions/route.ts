import { readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  INTERVIEW_REACTIONS,
  type InterviewReaction,
  type ReactionAssetCatalog,
} from "../../interview/ai/reactionConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ASSET_ROOT = path.join(process.cwd(), "public", "interview-reactions");
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

async function scanReaction(reaction: InterviewReaction): Promise<string[]> {
  try {
    const entries = await readdir(path.join(ASSET_ROOT, reaction), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }))
      .map(
        (entry) =>
          `/interview-reactions/${encodeURIComponent(reaction)}/${encodeURIComponent(entry.name)}`
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function GET() {
  const reactions: ReactionAssetCatalog = {};
  const scannedAssets = await Promise.all(INTERVIEW_REACTIONS.map(scanReaction));
  INTERVIEW_REACTIONS.forEach((reaction, index) => {
    const assets = scannedAssets[index];
    if (assets.length) reactions[reaction] = assets;
  });

  return NextResponse.json(
    { reactions },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

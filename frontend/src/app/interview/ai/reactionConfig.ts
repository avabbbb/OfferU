export const INTERVIEW_REACTIONS = [
  "ready",
  "calibrating",
  "focused",
  "steady",
  "straighten",
  "center",
  "missing",
  "smiling",
  "laughing",
  "surprised",
  "pouting",
  "tense",
  "victory",
  "thumbs-up",
  "thumbs-down",
  "open-palm",
  "pointing-up",
  "love",
  "closed-fist",
] as const;

export type InterviewReaction = (typeof INTERVIEW_REACTIONS)[number];

export type ReactionAssetCatalog = Partial<Record<InterviewReaction, string[]>>;

export const GESTURE_REACTION: Record<string, InterviewReaction> = {
  Victory: "victory",
  Thumb_Up: "thumbs-up",
  Thumb_Down: "thumbs-down",
  Open_Palm: "open-palm",
  Pointing_Up: "pointing-up",
  ILoveYou: "love",
  Closed_Fist: "closed-fist",
};

export const GESTURE_LABEL: Record<string, string> = {
  Victory: "比耶",
  Thumb_Up: "点赞",
  Thumb_Down: "拇指向下",
  Open_Palm: "张开手掌",
  Pointing_Up: "食指向上",
  ILoveYou: "I Love You",
  Closed_Fist: "握拳",
};

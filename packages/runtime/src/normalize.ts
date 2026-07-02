import {
  MessageItemType,
  WeChatClient,
  type MessageItem,
  type WeixinMessage,
} from "wechat2all";

import type {
  RuntimeAttachment,
  RuntimeMessage,
  RuntimeMessageKind,
} from "./types.js";

function messageId(msg: WeixinMessage): string {
  const sender = firstNonEmpty(
    msg.from_user_id,
    msg.session_id,
    msg.group_id,
    msg.to_user_id,
  );
  return String(
    msg.message_id ??
      msg.client_id ??
      msg.seq ??
      `${sender ?? "unknown"}-${msg.create_time_ms ?? Date.now()}`,
  );
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() === "" ? undefined : value;
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function numericSize(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function attachmentFromItem(item: MessageItem): RuntimeAttachment | null {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return {
        id: item.msg_id,
        kind: "image",
        size: item.image_item?.mid_size ?? item.image_item?.thumb_size,
        raw: item,
      };
    case MessageItemType.VOICE:
      return {
        id: item.msg_id,
        kind: "voice",
        durationMs: item.voice_item?.playtime,
        raw: item,
      };
    case MessageItemType.VIDEO:
      return {
        id: item.msg_id,
        kind: "video",
        size: item.video_item?.video_size,
        durationMs:
          item.video_item?.play_length == null
            ? undefined
            : item.video_item.play_length * 1000,
        raw: item,
      };
    case MessageItemType.FILE:
      return {
        id: item.msg_id,
        kind: "file",
        fileName: item.file_item?.file_name,
        size: numericSize(item.file_item?.len),
        raw: item,
      };
    default:
      return null;
  }
}

function inferKind(
  text: string | undefined,
  attachments: RuntimeAttachment[],
  itemList: MessageItem[],
): RuntimeMessageKind {
  const kinds = new Set(attachments.map((a) => a.kind));
  if (text && attachments.length > 0) return "mixed";
  if (text) return "text";
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.size > 1) return "mixed";
  if (itemList.length > 0) return "unknown";
  return "unknown";
}

export function normalizeWeixinMessage(params: {
  profileId: string;
  msg: WeixinMessage;
}): RuntimeMessage {
  const { profileId, msg } = params;
  const items = msg.item_list ?? [];
  const text = WeChatClient.extractText(msg) || undefined;
  const attachments = items
    .map(attachmentFromItem)
    .filter((item): item is RuntimeAttachment => item != null);
  const fromUserId = nonEmptyString(msg.from_user_id);
  const sessionId = nonEmptyString(msg.session_id);
  const groupId = nonEmptyString(msg.group_id);
  const toUserId = nonEmptyString(msg.to_user_id);
  const contextToken = nonEmptyString(msg.context_token);
  const senderId = firstNonEmpty(fromUserId, sessionId, groupId, toUserId) ?? "unknown";
  const conversationId = firstNonEmpty(groupId, sessionId, fromUserId, senderId) ?? "unknown";
  const timestamp = msg.create_time_ms ?? Date.now();

  return {
    id: messageId(msg),
    platform: "wechat-ilink",
    profileId,
    conversationId,
    senderId,
    recipientId: toUserId,
    timestamp,
    kind: inferKind(text, attachments, items),
    text,
    attachments,
    replyToken:
      senderId !== "unknown" && contextToken
        ? { userId: senderId, contextToken }
        : undefined,
    raw: msg,
  };
}

export const CODEX_PROCESSING_REMINDER_TEXTS = [
  "我还在处理，稍等我一下。",
  "这边还在跑，我继续等结果。",
  "还在处理当中，再给我一点时间。",
  "任务还没结束，我继续盯着。",
  "我还在忙这件事，处理好就回复你。",
  "还在进行中，有结果我就发给你。",
  "这边还需要一点时间，我继续处理。",
  "没有卡住，还在认真处理。",
  "我还在跟进，完成后告诉你。",
  "任务正在继续跑，请再等一会儿。",
  "我还在这里，结果出来就发你。",
  "这件事还在处理中，再稍等一下。",
  "还没处理完，我继续推进。",
  "这边还在处理细节，稍等片刻。",
  "我还在检查，确认好就回复你。",
  "进度还在继续，完成后第一时间发你。",
  "任务仍在运行，我会继续等结果。",
  "我正在跟进这次处理，稍后回复你。",
  "还在忙，处理完成我就回来。",
  "这边一切正常，只是还需要一点时间。",
] as const;

export function createCodexProcessingReminderPicker(
  random: () => number = Math.random,
): () => string {
  let previousIndex = -1;

  return () => {
    const availableCount = previousIndex < 0
      ? CODEX_PROCESSING_REMINDER_TEXTS.length
      : CODEX_PROCESSING_REMINDER_TEXTS.length - 1;
    const sampledIndex = Math.min(
      availableCount - 1,
      Math.max(0, Math.floor(random() * availableCount)),
    );
    const nextIndex = previousIndex >= 0 && sampledIndex >= previousIndex
      ? sampledIndex + 1
      : sampledIndex;

    previousIndex = nextIndex;
    return CODEX_PROCESSING_REMINDER_TEXTS[nextIndex];
  };
}

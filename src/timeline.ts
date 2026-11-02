
export type TimelineClip = {
  id: string;
  file: File;
  name: string;
  sourceStart: number;
  sourceEnd: number;
};

export function createClipId(): string {
  return `clip-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

export function createTimelineClip(
  file: File,
  duration: number,
  sourceStart = 0,
  sourceEnd = duration
): TimelineClip {
  return {
    id: createClipId(),
    file,
    name: file.name,
    sourceStart,
    sourceEnd,
  };
}

export function clipDuration(clip: TimelineClip): number {
  return Math.max(0, clip.sourceEnd - clip.sourceStart);
}

export function timelineDuration(clips: TimelineClip[]): number {
  return clips.reduce(
    (total, clip) => total + clipDuration(clip),
    0
  );
}

export function timelinePositionToSourceTime(
  clips: TimelineClip[],
  timelineTime: number
): { clipIndex: number; sourceTime: number } | null {
  let cursor = 0;

  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const duration = clipDuration(clip);
    const end = cursor + duration;

    if (timelineTime < end || index === clips.length - 1) {
      return {
        clipIndex: index,
        sourceTime: Math.min(
          clip.sourceEnd,
          clip.sourceStart + Math.max(0, timelineTime - cursor)
        ),
      };
    }

    cursor = end;
  }

  return null;
}

export function timelinePositionForClip(
  clips: TimelineClip[],
  clipIndex: number
): number {
  return clips
    .slice(0, Math.max(0, clipIndex))
    .reduce((total, clip) => total + clipDuration(clip), 0);
}

export function splitClipAt(
  clips: TimelineClip[],
  clipId: string,
  timelineTime: number
): TimelineClip[] {
  const result: TimelineClip[] = [];
  let cursor = 0;

  for (const clip of clips) {
    const duration = clipDuration(clip);
    const end = cursor + duration;

    if (
      clip.id !== clipId ||
      timelineTime <= cursor ||
      timelineTime >= end
    ) {
      result.push(clip);
      cursor = end;
      continue;
    }

    const splitPoint =
      clip.sourceStart + (timelineTime - cursor);

    result.push(
      {
        ...clip,
        id: createClipId(),
        sourceEnd: splitPoint,
      },
      {
        ...clip,
        id: createClipId(),
        sourceStart: splitPoint,
      }
    );

    cursor = end;
  }

  return result;
}

export function deleteClip(
  clips: TimelineClip[],
  clipId: string
): TimelineClip[] {
  return clips.filter(clip => clip.id !== clipId);
}

export function duplicateClip(
  clips: TimelineClip[],
  clipId: string
): TimelineClip[] {
  const index = clips.findIndex(clip => clip.id === clipId);

  if (index === -1) return clips;

  const copy: TimelineClip = {
    ...clips[index],
    id: createClipId(),
  };

  const result = [...clips];
  result.splice(index + 1, 0, copy);

  return result;
}

export function moveClip(
  clips: TimelineClip[],
  fromIndex: number,
  toIndex: number
): TimelineClip[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= clips.length ||
    toIndex >= clips.length ||
    fromIndex === toIndex
  ) {
    return clips;
  }

  const result = [...clips];
  const [clip] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, clip);

  return result;
}

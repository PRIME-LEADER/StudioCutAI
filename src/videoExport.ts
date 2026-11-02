
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { LookPreset, TransitionStyle } from "./videoStyle";

export type VideoExportOptions = {
  startTime?: number;
  endTime?: number;
  segments?: Array<{ sourceStart: number; sourceEnd: number; file?: File }>;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  look?: LookPreset;
  transition?: TransitionStyle;
  transitionDuration?: number;
  titleOverlay?: Blob | null;
  musicFile?: File | null;
  videoVolume?: number;
  musicVolume?: number;
  musicStart?: number;
  musicSourceStart?: number;
  musicSourceEnd?: number;
  onProgress?: (progress: number) => void;
};

let ffmpegInstance: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;
let exportQueue: Promise<void> = Promise.resolve();
let jobCounter = 0;

const CORE_BASE_URL = `${import.meta.env.BASE_URL}ffmpeg`;

function safeFileExtension(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;

  if (!loadingPromise) {
    loadingPromise = (async () => {
      const ffmpeg = new FFmpeg();

      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${CORE_BASE_URL}/ffmpeg-core.js`,
          "text/javascript"
        ),
        wasmURL: await toBlobURL(
          `${CORE_BASE_URL}/ffmpeg-core.wasm`,
          "application/wasm"
        ),
      });

      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch((error) => {
      loadingPromise = null;
      ffmpegInstance = null;
      throw error;
    });
  }

  return loadingPromise;
}

async function runExport<T>(job: () => Promise<T>): Promise<T> {
  const previous = exportQueue;
  let release!: () => void;

  exportQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await job();
  } finally {
    release();
  }
}

function validateTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be zero or greater.`);
  }
}

function validateVolume(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error(`${label} must be between 0 and 2.`);
  }
}

function listenForProgress(
  ffmpeg: FFmpeg,
  onProgress?: (progress: number) => void
) {
  const listener = ({ progress }: { progress: number }) => {
    if (Number.isFinite(progress)) {
      onProgress?.(Math.min(99, Math.max(0, Math.round(progress * 100))));
    }
  };

  ffmpeg.on("progress", listener);
  return () => ffmpeg.off("progress", listener);
}

async function removeFiles(ffmpeg: FFmpeg, files: string[]) {
  for (const filename of files) {
    try {
      await ffmpeg.deleteFile(filename);
    } catch {
      // The file might not have been created.
    }
  }
}

export async function exportVideo(
  videoFile: File,
  options: VideoExportOptions = {}
): Promise<Blob> {
  return runExport(async () => {
    const {
      startTime = 0,
      endTime,
      brightness = 0,
      contrast = 1,
      saturation = 1,
      look = "none",
      transition = "cut",
      transitionDuration = 0.35,
      titleOverlay = null,
      musicFile = null,
      videoVolume = 1,
      musicVolume = 0.8,
      musicStart = 0,
      musicSourceStart = 0,
      musicSourceEnd,
      onProgress,
    } = options;

    if (!videoFile || videoFile.size === 0) {
      throw new Error("Choose a valid video before exporting.");
    }

    validateTime(startTime, "Video start time");

    if (endTime !== undefined) {
      validateTime(endTime, "Video end time");
      if (endTime <= startTime) {
        throw new Error("Video end time must be after its start time.");
      }
    }

    validateTime(musicStart, "Music timeline position");
    if (
      !Number.isFinite(transitionDuration) ||
      transitionDuration < 0 ||
      transitionDuration > 1.5
    ) {
      throw new Error("Transition duration must be between 0 and 1.5 seconds.");
    }

    validateTime(musicSourceStart, "Music source start time");

    if (musicSourceEnd !== undefined) {
      validateTime(musicSourceEnd, "Music source end time");
      if (musicSourceEnd <= musicSourceStart) {
        throw new Error("Music source end time must be after its start time.");
      }
    }

    validateVolume(videoVolume, "Video volume");
    validateVolume(musicVolume, "Music volume");

    if (
      !Number.isFinite(brightness) ||
      brightness < -1 ||
      brightness > 1 ||
      !Number.isFinite(contrast) ||
      contrast < 0 ||
      contrast > 2 ||
      !Number.isFinite(saturation) ||
      saturation < 0 ||
      saturation > 3
    ) {
      throw new Error("Check your brightness, contrast, and saturation values.");
    }

    if (musicFile && musicFile.size === 0) {
      throw new Error("The selected music file is empty.");
    }

    const ffmpeg = await getFFmpeg();
    const id = ++jobCounter;
    const segments = options.segments
    const sourceFiles = [
      ...new Set(
        (segments?.map(segment => segment.file ?? videoFile) ?? [videoFile]),
      ),
    ]
    const sourceInputs = sourceFiles.map(
      (file, index) =>
        `studio_video_${id}_${index}.${safeFileExtension(file)}`,
    )
    const musicInput = `studio_music_${id}.${musicFile ? safeFileExtension(musicFile) : "bin"}`;
    const titleInput = `studio_title_${id}.png`;
    const outputName = `studio_output_${id}.mp4`;
    const files = [...sourceInputs, musicInput, titleInput, outputName];
    const stopProgress = listenForProgress(ffmpeg, onProgress);
    const logs: string[] = [];

    const logListener = ({ message }: { message: string }) => {
      logs.push(message);
      if (logs.length > 150) logs.shift();
    };

    ffmpeg.on("log", logListener);

    try {
      onProgress?.(0);
      const sourceMetadata = new Map<File, { duration: number; hasAudio: boolean }>()
      for (const [index, file] of sourceFiles.entries()) {
        await ffmpeg.writeFile(sourceInputs[index], await fetchFile(file))
        logs.length = 0
        let probeError: unknown
        try {
          await ffmpeg.exec(["-hide_banner", "-i", sourceInputs[index]])
        } catch (error) {
          probeError = error
        }
        const probedDuration = logs
          .map(line => line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/))
          .find(Boolean)
        const duration = probedDuration
          ? Number(probedDuration[1]) * 3600 +
            Number(probedDuration[2]) * 60 +
            Number(probedDuration[3])
          : undefined
        if (duration === undefined || !Number.isFinite(duration)) {
          const details = logs.slice(-8).join("\n")
          throw new Error(
            `Could not read ${file.name}.${details ? `\n${details}` : probeError instanceof Error ? ` ${probeError.message}` : ""}`,
          )
        }
        sourceMetadata.set(file, {
          duration,
          hasAudio: logs.some(line => /Stream #0:\d+.*Audio:/i.test(line)),
        })
      }

      const editSegments = segments ?? [{
        sourceStart: startTime,
        sourceEnd: endTime ?? sourceMetadata.get(videoFile)!.duration,
        file: videoFile,
      }];

      if (editSegments.length === 0) {
        throw new Error("Add at least one video clip before exporting.");
      }

      for (const [index, segment] of editSegments.entries()) {
        validateTime(segment.sourceStart, `Video clip ${index + 1} start time`);
        validateTime(segment.sourceEnd, `Video clip ${index + 1} end time`);
        if (segment.sourceEnd <= segment.sourceStart) {
          throw new Error(`Video clip ${index + 1} has an empty time range.`);
        }
        const source = segment.file ?? videoFile
        const metadata = sourceMetadata.get(source)
        if (!metadata || segment.sourceEnd > metadata.duration + 0.05) {
          throw new Error(`Video clip ${index + 1} ends after its source video.`);
        }
      }

      const sourceDurationTotal = editSegments.reduce(
        (total, segment) => total + segment.sourceEnd - segment.sourceStart,
        0,
      );
      const actualTransitionDuration =
        transition === "cut" || editSegments.length < 2
          ? 0
          : Math.min(
              transitionDuration,
              ...editSegments.map(
                segment => (segment.sourceEnd - segment.sourceStart) * 0.45,
              ),
            )
      const outputDuration =
        sourceDurationTotal -
        actualTransitionDuration * Math.max(0, editSegments.length - 1)
      if (musicFile && musicSourceEnd === undefined) {
        throw new Error("Wait for the music duration to load before exporting.");
      }

      const args: string[] = ["-hide_banner", "-y"];
      sourceInputs.forEach(input => args.push("-i", input));

      if (musicFile) {
        await ffmpeg.writeFile(musicInput, await fetchFile(musicFile));

        // musicStart is the soundtrack's position on the exported timeline.
        args.push("-i", musicInput);
      }

      if (titleOverlay) {
        await ffmpeg.writeFile(titleInput, await fetchFile(titleOverlay));
        args.push("-loop", "1", "-framerate", "30", "-i", titleInput);
      }

      const musicInputIndex = sourceInputs.length
      const titleInputIndex = musicInputIndex + (musicFile ? 1 : 0)
      const filters: string[] = [];
      const videoLabels: string[] = [];
      const audioLabels: string[] = [];

      editSegments.forEach((segment, index) => {
        const start = segment.sourceStart.toFixed(3)
        const end = segment.sourceEnd.toFixed(3)
        const file = segment.file ?? videoFile
        const sourceIndex = sourceFiles.indexOf(file)
        const source = sourceMetadata.get(file)!
        const videoLabel = `video${index}`
        const audioLabel = `sourceAudio${index}`
        const segmentDuration = (segment.sourceEnd - segment.sourceStart).toFixed(3)
        filters.push(
          `[${sourceIndex}:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,format=yuv420p[${videoLabel}]`,
        )
        videoLabels.push(videoLabel)
        if (source.hasAudio) {
          filters.push(
            `[${sourceIndex}:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,volume=${videoVolume},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[${audioLabel}]`,
          )
        } else {
          filters.push(
            `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${segmentDuration}[${audioLabel}]`,
          )
        }
        audioLabels.push(audioLabel)
      })

      let videoJoinedLabel = videoLabels[0]
      let audioJoinedLabel = audioLabels[0]
      if (actualTransitionDuration > 0) {
        let elapsedDuration = 0
        const transitionName: Record<Exclude<TransitionStyle, 'cut'>, string> = {
          dissolve: 'dissolve',
          fade: 'fade',
          wipe: 'smoothleft',
        }
        for (let index = 1; index < editSegments.length; index++) {
          const duration = editSegments[index - 1].sourceEnd -
            editSegments[index - 1].sourceStart
          elapsedDuration += duration
          const offset = Math.max(
            0,
            elapsedDuration - actualTransitionDuration * index,
          )
          const nextVideoLabel = `videoTransition${index}`
          const nextAudioLabel = `audioTransition${index}`
          filters.push(
            `[${videoJoinedLabel}][${videoLabels[index]}]xfade=transition=${transitionName[transition as Exclude<TransitionStyle, 'cut'>]}:duration=${actualTransitionDuration.toFixed(3)}:offset=${offset.toFixed(3)}[${nextVideoLabel}]`,
          )
          filters.push(
            `[${audioJoinedLabel}][${audioLabels[index]}]acrossfade=d=${actualTransitionDuration.toFixed(3)}:c1=tri:c2=tri[${nextAudioLabel}]`,
          )
          videoJoinedLabel = nextVideoLabel
          audioJoinedLabel = nextAudioLabel
        }
      } else {
        filters.push(
          `${videoLabels.map(label => `[${label}]`).join('')}concat=n=${editSegments.length}:v=1:a=0[videoJoined]`,
        )
        filters.push(
          `${audioLabels.map(label => `[${label}]`).join('')}concat=n=${editSegments.length}:v=0:a=1[originalAudio]`,
        )
        videoJoinedLabel = 'videoJoined'
        audioJoinedLabel = 'originalAudio'
      }
      if (actualTransitionDuration > 0) {
        filters.push(`[${videoJoinedLabel}]null[videoJoined]`)
        filters.push(`[${audioJoinedLabel}]anull[originalAudio]`)
      }
      const lookFilters: Record<LookPreset, string> = {
        none: "",
        cinematic: "eq=brightness=-0.03:contrast=1.15:saturation=0.88",
        warm: "eq=brightness=0.02:contrast=1.04:saturation=1.15",
        vivid: "eq=brightness=0:contrast=1.12:saturation=1.3",
        mono: "hue=s=0,eq=brightness=0:contrast=1.08:saturation=1",
      };
      const customGrade =
        `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`;
      const filtersForLook = [lookFilters[look], customGrade]
        .filter(Boolean)
        .join(",");
      filters.push(`[videoJoined]${filtersForLook}[videoStyled]`);
      if (titleOverlay) {
        filters.push(
          `[videoStyled][${titleInputIndex}:v]overlay=0:0:shortest=1[videoOut]`,
        );
      } else {
        filters.push("[videoStyled]null[videoOut]");
      }
      filters.push(
        `[originalAudio]apad,atrim=duration=${outputDuration.toFixed(3)}[originalAudioPadded]`,
      )
      if (musicFile && musicSourceEnd !== undefined) {
        let musicFilter =
          `[${musicInputIndex}:a:0]atrim=start=${musicSourceStart.toFixed(3)}:end=${musicSourceEnd.toFixed(3)},asetpts=PTS-STARTPTS,volume=${musicVolume}`
        if (musicStart > 0) {
          musicFilter += `,adelay=${Math.round(musicStart * 1000)}:all=1`
        }
        filters.push(`${musicFilter}[musicTrack]`)
        filters.push(
          `[originalAudioPadded][musicTrack]amix=inputs=2:duration=first:dropout_transition=2[audioOut]`,
        )
      } else {
        filters.push("[originalAudioPadded]anull[audioOut]")
      }

      args.push("-filter_complex", filters.join(";"));
      args.push("-map", "[videoOut]")
      args.push("-map", "[audioOut]")
      args.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
      )

      args.push(
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        outputName
      );

      const exitCode = await ffmpeg.exec(args);

      if (exitCode !== 0) {
        const details = logs.slice(-12).join("\n");
        throw new Error(
          `Video export failed (FFmpeg code ${exitCode}).\n${details || "Check the media format and selected time range."}`
        );
      }

      const output = await ffmpeg.readFile(outputName);

      if (!(output instanceof Uint8Array) || output.length === 0) {
        throw new Error("FFmpeg did not produce a valid video file.");
      }

      onProgress?.(100);
      return new Blob([output.slice()], { type: "video/mp4" });
      /*
      const segments = options.segments ?? [{
        sourceStart: startTime,
        sourceEnd: endTime ?? sourceDuration ?? startTime,
      }];

      if (segments.length === 0) {
        throw new Error("Add at least one video clip before exporting.");
      }

      for (const [index, segment] of segments.entries()) {
        validateTime(segment.sourceStart, `Video clip ${index + 1} start time`);
        validateTime(segment.sourceEnd, `Video clip ${index + 1} end time`);
        if (segment.sourceEnd <= segment.sourceStart) {
          throw new Error(`Video clip ${index + 1} has an empty time range.`);
        }
        if (
          sourceDuration !== undefined &&
          segment.sourceEnd > sourceDuration + 0.05
        ) {
          throw new Error(`Video clip ${index + 1} ends after the source video.`);
        }
      }

      const outputDuration = segments.reduce(
        (total, segment) => total + segment.sourceEnd - segment.sourceStart,
        0,
      );
      if (musicFile && musicSourceEnd === undefined) {
        throw new Error("Wait for the music duration to load before exporting.");
      }

      const args: string[] = ["-hide_banner", "-y"];
      args.push("-i", videoInput);

      if (musicFile) {
        await ffmpeg.writeFile(musicInput, await fetchFile(musicFile));

        // musicStart is the soundtrack's position on the exported timeline.
        args.push("-i", musicInput);
      }

      if (titleOverlay) {
        await ffmpeg.writeFile(titleInput, await fetchFile(titleOverlay));
        args.push("-loop", "1", "-framerate", "30", "-i", titleInput);
      }

      const filters: string[] = [];
      const concatInputs: string[] = [];

      segments.forEach((segment, index) => {
        const start = segment.sourceStart.toFixed(3)
        const end = segment.sourceEnd.toFixed(3)
        const videoLabel = `video${index}`
        filters.push(
          `[0:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${videoLabel}]`,
        )
        concatInputs.push(`[${videoLabel}]`)

        if (hasOriginalAudio) {
          const audioLabel = `sourceAudio${index}`
          filters.push(
            `[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,volume=${videoVolume}[${audioLabel}]`,
          )
          concatInputs.push(`[${audioLabel}]`)
        }
      })

      const concatAudio = hasOriginalAudio ? 1 : 0
      filters.push(
        `${concatInputs.join('')}concat=n=${segments.length}:v=1:a=${concatAudio}[videoJoined]${hasOriginalAudio ? '[audioJoined]' : ''}`,
      )
      const lookFilters: Record<LookPreset, string> = {
        none: "",
        cinematic: "eq=brightness=-0.03:contrast=1.15:saturation=0.88",
        warm: "eq=brightness=0.02:contrast=1.04:saturation=1.15",
        vivid: "eq=brightness=0:contrast=1.12:saturation=1.3",
        mono: "hue=s=0,eq=brightness=0:contrast=1.08:saturation=1",
      };
      const customGrade =
        `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`;
      const filtersForLook = [lookFilters[look], customGrade]
        .filter(Boolean)
        .join(",");
      filters.push(`[videoJoined]${filtersForLook}[videoStyled]`);
      if (titleOverlay) {
        const titleInputIndex = musicFile ? 2 : 1;
        filters.push(
          `[videoStyled][${titleInputIndex}:v]overlay=0:0:shortest=1[videoOut]`,
        );
      } else {
        filters.push("[videoStyled]null[videoOut]");
      }
      if (hasOriginalAudio) {
        filters.push(
          `[audioJoined]apad,atrim=duration=${outputDuration.toFixed(3)}[originalAudio]`,
        )
      }

      if (musicFile && musicSourceEnd !== undefined) {
        let musicFilter =
          `[1:a:0]atrim=start=${musicSourceStart.toFixed(3)}:end=${musicSourceEnd.toFixed(3)},asetpts=PTS-STARTPTS,volume=${musicVolume}`
        if (musicStart > 0) {
          musicFilter += `,adelay=${Math.round(musicStart * 1000)}:all=1`
        }
        filters.push(`${musicFilter}[musicTrack]`)

        if (hasOriginalAudio) {
          filters.push(
            `[originalAudio][musicTrack]amix=inputs=2:duration=first:dropout_transition=2[audioOut]`,
          )
        } else {
          filters.push(
            `[musicTrack]apad,atrim=duration=${outputDuration.toFixed(3)}[audioOut]`,
          )
        }
      }

      args.push("-filter_complex", filters.join(";"));
      args.push("-map", "[videoOut]")

      if (hasOriginalAudio || musicFile) {
        args.push("-map", musicFile ? "[audioOut]" : "[originalAudio]")
      } else {
        args.push("-an")
      }

      args.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
      )

      args.push(
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        outputName
      );

      const exitCode = await ffmpeg.exec(args);

      if (exitCode !== 0) {
        const details = logs.slice(-12).join("\n");
        throw new Error(
          `Video export failed (FFmpeg code ${exitCode}).\n${details || "Check the media format and selected time range."}`
        );
      }

      const output = await ffmpeg.readFile(outputName);

      if (!(output instanceof Uint8Array) || output.length === 0) {
        throw new Error("FFmpeg did not produce a valid video file.");
      }

      onProgress?.(100);
      return new Blob([output.slice()], { type: "video/mp4" });
      */
    } catch (error) {
      console.error("StudioCut AI export error:", error);
      throw error instanceof Error
        ? error
        : new Error("An unexpected export error occurred.");
    } finally {
      stopProgress();
      ffmpeg.off("log", logListener);
      await removeFiles(ffmpeg, files);
    }
  });
}

export async function extractAudio(
  videoFile: File,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  return runExport(async () => {
    if (!videoFile || videoFile.size === 0) {
      throw new Error("Choose a valid video before extracting audio.");
    }

    const ffmpeg = await getFFmpeg();
    const id = ++jobCounter;
    const inputName = `studio_audio_source_${id}.${safeFileExtension(videoFile)}`;
    const mp3Name = `studio_extracted_${id}.mp3`;
    const m4aName = `studio_extracted_${id}.m4a`;
    const stopProgress = listenForProgress(ffmpeg, onProgress);
    const logs: string[] = [];

    const logListener = ({ message }: { message: string }) => {
      logs.push(message);
      if (logs.length > 100) logs.shift();
    };

    ffmpeg.on("log", logListener);

    try {
      onProgress?.(0);
      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

      // Try MP3 first.
      const mp3ExitCode = await ffmpeg.exec([
        "-hide_banner", "-y",
        "-i", inputName,
        "-vn",
        "-map", "0:a:0",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        mp3Name,
      ]);

      if (mp3ExitCode === 0) {
        const output = await ffmpeg.readFile(mp3Name);
        if (output instanceof Uint8Array && output.length > 0) {
          onProgress?.(100);
          return new Blob([output.slice()], { type: "audio/mpeg" });
        }
      }

      // Fallback: AAC audio in an M4A container.
      const m4aExitCode = await ffmpeg.exec([
        "-hide_banner", "-y",
        "-i", inputName,
        "-vn",
        "-map", "0:a:0",
        "-c:a", "aac",
        "-b:a", "192k",
        m4aName,
      ]);

      if (m4aExitCode !== 0) {
        const hasAudio = logs.some((line) => /Stream #0:\d+.*Audio:/i.test(line));

        throw new Error(
          hasAudio
            ? `Audio extraction failed. FFmpeg details:\n${logs.slice(-10).join("\n")}`
            : "This video does not appear to contain an audio track."
        );
      }

      const output = await ffmpeg.readFile(m4aName);

      if (!(output instanceof Uint8Array) || output.length === 0) {
        throw new Error("No audio file was produced.");
      }

      onProgress?.(100);
      return new Blob([output.slice()], { type: "audio/mp4" });
    } catch (error) {
      console.error("StudioCut AI audio extraction error:", error);
      throw error instanceof Error ? error : new Error("Audio extraction failed.");
    } finally {
      stopProgress();
      ffmpeg.off("log", logListener);
      await removeFiles(ffmpeg, [inputName, mp3Name, m4aName]);
    }
  });
}

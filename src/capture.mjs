// 采集适配器：把 dsh-see-now 的 spawnFrames 包成门面要的形状。
//
// 只做三件事：限定区域、按目标尺寸缩放、按 fps 出帧。
// 判据、档位、拼图都在 pipeline 里，不在这里。
import { spawnFrames } from '../vendor/dsh-see-now-main/src/capture.js'

export function startCapture({ region, width, height, fps = 8, onFrame, onStderr, onClose } = {}) {
  // 门面用的是 {x,y,width,height}（windowRect 的形状），
  // 而 ffmpeg 那一层要的是 {x,y,w,h} —— 不转换会拼出 `-video_size undefinedxundefined`。
  const box = region
    ? { x: region.x, y: region.y, w: region.width ?? region.w, h: region.height ?? region.h }
    : undefined

  const handle = spawnFrames({
    source: box ? { kind: 'screen', region: box } : { kind: 'screen' },
    width,
    height,
    fps,
    // 必须显式指定：0.2.5 的 isDda() 没判断 region，会给 gdigrab 拼上 hwdownload，
    // 导致 ffmpeg 一帧都出不来。
    engine: 'gdigrab',
    onFrame,
    onStderr,
  })

  handle.done
    .then((info) => onClose?.(info))
    .catch((err) => onClose?.(err))

  return {
    arg: { region, width, height, fps },
    stop: () => handle.stop?.(),
  }
}

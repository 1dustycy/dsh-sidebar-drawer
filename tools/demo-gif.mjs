// 把一段屏幕录制转成 README 用的演示 GIF：node tools/demo-gif.mjs <录屏文件> [输出路径]
//
// README 里那张动图由这个脚本生成 —— 参数写死在这里，改这里就等于改那张图的长相。
// 三条约定，都跟"深色 UI 的录屏"有关：
//   - 全局调色板（palettegen 只跑一遍）：逐帧调色板会让静态区域在帧间轻微变色；
//   - dither=sierra2_4a：UI 背景几乎无渐变（实测一行只有 4 个灰阶），抖动只在文字边缘起作用；
//   - diff_mode=rectangle：帧间未变化的像素写成透明，于是"指针在动、画面不动"的那些秒几乎不占体积。
// 25fps 是 GIF 能精确表达的帧率（每帧 4 厘秒）；30fps 会被四舍五入成 3 厘秒而变慢。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIDTH = 960;
const FPS = 25;

const [input, output = "docs/drawer-demo.gif"] = process.argv.slice(2);
if (!input) {
	console.error("用法: node tools/demo-gif.mjs <录屏文件> [输出路径]");
	process.exit(1);
}

const scale = `fps=${FPS},scale=${WIDTH}:-2:flags=lanczos`;
const work = mkdtempSync(join(tmpdir(), "dsh-demo-gif-"));
const palette = join(work, "palette.png");

const ffmpeg = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });

try {
	ffmpeg(["-i", input, "-vf", `${scale},palettegen=stats_mode=diff`, palette]);
	ffmpeg([
		"-i", input,
		"-i", palette,
		"-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
		"-loop", "0",
		output,
	]);
} finally {
	rmSync(work, { recursive: true, force: true });
}

const bytes = statSync(output).size;
console.log(`${output}  ${WIDTH}px  ${FPS}fps  ${(bytes / 1024 / 1024).toFixed(2)} MiB`);

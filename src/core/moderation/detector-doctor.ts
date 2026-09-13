/**
 * 检测引擎自检 CLI。
 *
 * 后台「引擎」页只能看到「未安装」这一句结论，排查要靠猜。这个命令把
 * 运行环境（Node 版本、require(ESM) 能力）和每个引擎的加载失败原因、
 * 可照做的修复建议一次性打印出来。
 *
 * 用法：npm run moderation:doctor
 * 退出码：存在声明依赖的引擎不可用时为 1，便于 CI / Docker 构建自检。
 */

import { listDetectorInfo } from './detectors';

/** Node 20.19 / 22.12 起 require(ESM) 默认可用；更早版本只能 require CJS */
function requireEsmSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number(part));
  if (Number.isNaN(major) || Number.isNaN(minor)) return false;
  if (major >= 23) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor >= 19;
  return false;
}

function main(): void {
  const detectors = listDetectorInfo();
  const esmOk = requireEsmSupported();

  console.log(`[Moderation] Node ${process.version}  require(ESM)=${esmOk ? '支持' : '不支持'}`);
  if (!esmOk) {
    console.log('[Moderation] 提示：visulima / whitz 是纯 ESM 包，当前 Node 无法用 require 加载它们。');
    console.log('[Moderation]       升级到 Node 22.12+ 或 20.19+ 即可解决。');
  }
  console.log('');

  let missing = 0;
  for (const detector of detectors) {
    const status = detector.available ? '可用  ' : '不可用';
    console.log(`${status}  ${detector.id.padEnd(16)}${detector.dependency ?? '(内置引擎)'}`);
    if (!detector.available) {
      if (detector.dependency) missing += 1;
      console.log(`          原因：${detector.reason ?? '未知'}`);
      console.log(`          修复：${detector.hint ?? '重装依赖后重启服务'}`);
    }
  }

  console.log('');
  if (missing === 0) {
    console.log('[Moderation] 全部引擎可用。');
    return;
  }
  console.log(`[Moderation] ${missing} 个可选依赖不可用：审核策略里勾选它们不会生效，其余引擎照常工作。`);
  console.log('[Moderation] 一键修复：npm install --include=optional @visulima/content-safety whitz-word-detector obscenity');
  process.exitCode = 1;
}

main();

#!/usr/bin/env bash
# 版本同步:一条命令把版本号写进三处唯一要维护的地方,保证 bridge / 扩展 / skill 永远同代。
#
#   ./scripts/bump-version.sh 1.6.0    把三处改成 1.6.0(manifest 另写 version_name 带 build 戳)
#   ./scripts/bump-version.sh --check  只校验三处是否一致,不改文件(install.sh / CI 用,不一致退出码 1)
#   ./scripts/bump-version.sh --show   打印三处当前版本
#
# 为什么要有它:扩展版本在 manifest.json、bridge 版本在 package.json、skill 版本在 SKILL.md,
# 手工维护必然漏改;漏改的后果是"升级了却不知道哪端没跟上",正是本脚本要消灭的问题。
set -euo pipefail

# 本脚本在 scripts/ 下,项目根是其上一级
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$PROJECT_DIR/mcp-bridge/package.json"
MANIFEST="$PROJECT_DIR/extension/manifest.json"
SKILL="$PROJECT_DIR/skill/browser-link-tool/SKILL.md"

for f in "$PKG" "$MANIFEST" "$SKILL"; do
  [ -f "$f" ] || { echo "!! 缺少文件: $f" >&2; exit 1; }
done

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}/versions/node"
  if [ -d "$nvm_dir" ]; then
    for d in "$nvm_dir"/v*/bin/node; do [ -x "$d" ] && { echo "$d"; return 0; }; done
  fi
  return 1
}
NODE_BIN="$(resolve_node || true)"
[ -n "$NODE_BIN" ] || { echo "!! 未找到 node" >&2; exit 1; }

MODE="${1:-}"
[ -n "$MODE" ] || { echo "用法: $0 <version> | --check | --show" >&2; exit 1; }

"$NODE_BIN" - "$PKG" "$MANIFEST" "$SKILL" "$MODE" <<'JS'
const fs = require('fs');
const path = require('path');
const [pkgPath, manifestPath, skillPath, mode] = process.argv.slice(2);

// skill 版本载体:HTML 注释,md 里不渲染、agent 读到也无害,且不动 frontmatter(避免客户端 schema 校验挑刺)
const SKILL_RE = /<!--\s*blt-version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*-->/;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const skillText = () => fs.readFileSync(skillPath, 'utf8');
const current = () => ({
  bridge: readJson(pkgPath).version || null,
  extension: readJson(manifestPath).version || null,
  skill: (skillText().match(SKILL_RE) || [])[1] || null,
});

const show = (v) => {
  console.log(`  bridge    (mcp-bridge/package.json)  : ${v.bridge || '(缺失)'}`);
  console.log(`  extension (extension/manifest.json)  : ${v.extension || '(缺失)'}`);
  console.log(`  skill     (skill/**/SKILL.md)        : ${v.skill || '(缺失)'}`);
};

if (mode === '--show' || mode === '--check') {
  const v = current();
  const ok = v.bridge && v.bridge === v.extension && v.bridge === v.skill;
  if (mode === '--show') { console.log('==> 当前版本:'); show(v); process.exit(0); }
  if (ok) { console.log(`==> 版本一致 ✔ v${v.bridge}`); process.exit(0); }
  console.error('!! 三处版本不一致,升级会出现「一端新一端旧」:');
  show(v);
  console.error(`   修复: ./scripts/bump-version.sh ${v.bridge || '<version>'}`);
  process.exit(1);
}

const ver = mode;
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) {
  console.error(`!! 版本号必须是 x.y.z,收到: ${ver}`);
  process.exit(1);
}

// build 戳(秒级):同版本号下区分构建批次,写进 manifest 的 version_name。
// Chrome 的 version 字段只收数字段,version_name 才允许任意字符串,故 build 戳只能挂后者。
const build = Math.floor(Date.now() / 1000);

// package.json:只替换 version 那一行,不走 JSON.stringify 重排(避免整文件 diff 噪音)
const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
const pkgNext = pkgRaw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${ver}"`);
if (pkgNext === pkgRaw && readJson(pkgPath).version !== ver) {
  console.error('!! 未能在 package.json 中定位 version 字段'); process.exit(1);
}
fs.writeFileSync(pkgPath, pkgNext);

// package-lock.json 根包版本必须同步:否则使用方 install.sh 里的 npm install 会改写它,
// 把使用方的克隆弄脏 → 其 init 脚本「有未提交改动」从此跳过 fast-forward,再也拉不到新版
const lockPath = path.join(path.dirname(pkgPath), 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.version = ver;
  if (lock.packages && lock.packages['']) lock.packages[''].version = ver;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n'); // 与 npm 写出格式一致,无 diff 噪音
}

// manifest.json:version 同步,并 upsert version_name = "x.y.z+build.<epoch>"
let mfRaw = fs.readFileSync(manifestPath, 'utf8');
mfRaw = mfRaw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${ver}"`);
const versionName = `${ver}+build.${build}`;
if (/"version_name"\s*:/.test(mfRaw)) {
  mfRaw = mfRaw.replace(/("version_name"\s*:\s*)"[^"]*"/, `$1"${versionName}"`);
} else {
  mfRaw = mfRaw.replace(/("version"\s*:\s*"[^"]*",)/, `$1\n  "version_name": "${versionName}",`);
}
JSON.parse(mfRaw); // 写回前自检,防正则改坏结构
fs.writeFileSync(manifestPath, mfRaw);

// SKILL.md:upsert 版本注释(放 frontmatter 之后、正文标题之前)
let sk = skillText();
if (SKILL_RE.test(sk)) {
  sk = sk.replace(SKILL_RE, `<!-- blt-version: ${ver} -->`);
} else {
  const m = sk.match(/^---\n[\s\S]*?\n---\n/);
  if (!m) { console.error('!! SKILL.md 缺少 frontmatter,无法定位插入点'); process.exit(1); }
  sk = m[0] + `\n<!-- blt-version: ${ver} -->\n` + sk.slice(m[0].length);
}
fs.writeFileSync(skillPath, sk);

console.log(`==> 已同步到 v${ver} (build ${build})`);
console.log(`  bridge    : ${pkgPath}`);
console.log(`  extension : ${manifestPath}  (version_name: ${versionName})`);
console.log(`  skill     : ${skillPath}`);
console.log('');
console.log('下一步:');
console.log('  1. 重新分发 skill   : ./scripts/sync-skills-local.sh');
console.log('  2. 浏览器重载扩展   : chrome://extensions → Browser Link Tool → 刷新按钮');
console.log('  3. 新开 agent 会话  : 新版 client 会自动请旧 daemon 退位');
JS

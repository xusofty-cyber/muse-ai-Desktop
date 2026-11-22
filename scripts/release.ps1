# Muse 发版脚本
# 用法: powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 1.5.33
# 步骤: 检查 -> npm test -> 只暂存指定文件 -> 确认后提交 -> 确认提交成功且版本号正确 -> 推送 main -> 在该提交上打标签并推送
param([Parameter(Mandatory=$true)][string]$Version)

$tag = "v$Version"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($msg) { Write-Host "`n[失败] $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }
function Ask($msg) { $a = Read-Host "$msg (y/N)"; if ($a -ne 'y') { Write-Host '已取消，没有做后续操作。'; exit 0 } }

# 本次要提交的文件 (不要用 git add -A: 仓库里有大量不该提交的未跟踪文件)
$files = @(
  'preload-chat-export.js',
  'package.json',
  'package-lock.json',
  'docs/CHANGES-2026-11-22.md',
  'docs/RELEASE-v1.5.32.md',
  "docs/RELEASE-$tag.md",
  'scripts/release.ps1'
)

Step '1/7 检查'
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Fail "当前分支是 $branch，请先切到 main" }
git fetch origin --tags
if ($LASTEXITCODE -ne 0) { Fail 'git fetch 失败，检查网络或 SSH' }
$behind = (git rev-list --count HEAD..origin/main).Trim()
if ($behind -ne '0') { Fail "本地落后 origin/main $behind 个提交，请先 git pull" }
if (git tag --list $tag) { Fail "标签 $tag 已存在" }
$pkgVer = (node -p "require('./package.json').version").Trim()
if ($pkgVer -ne $Version) { Fail "package.json 版本是 $pkgVer，不是 $Version" }
foreach ($f in $files) { if (-not (Test-Path $f)) { Fail "找不到文件 $f" } }
Write-Host "分支 main，与远程同步，版本 $Version，标签 $tag 未占用"

Step '2/7 npm test'
npm test
if ($LASTEXITCODE -ne 0) { Fail 'npm test 未通过' }

Step '3/7 暂存'
git add -- $files
if ($LASTEXITCODE -ne 0) { Fail 'git add 失败' }
git status --short --untracked-files=no
$staged = git diff --cached --name-only
if (-not $staged) { Fail '暂存区为空' }
$unexpected = $staged | Where-Object { $files -notcontains $_ }
if ($unexpected) { Fail ("暂存区里有清单外的文件: " + ($unexpected -join ', ') + "`n用 git restore --staged <文件> 移出后重跑") }
Write-Host "`n将提交以下文件:"; $staged | ForEach-Object { Write-Host "  $_" }

Step '4/7 提交'
Ask "提交为 `"$tag`"?"
$before = (git rev-parse HEAD).Trim()
git commit -m "$tag" -m "修复: 新建旁聊发消息后账号栏跑到屏幕中间 (账号栏改挂到 <html> 下, 位置样式 !important)" -m "补交 docs/RELEASE-v1.5.32.md; 新增通用发版脚本 scripts/release.ps1"
if ($LASTEXITCODE -ne 0) { Fail 'git commit 失败' }
$head = (git rev-parse HEAD).Trim()
if ($head -eq $before) { Fail '提交没有生成，HEAD 没变' }
$commitVer = (git show "HEAD:package.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))").Trim()
if ($commitVer -ne $Version) { Fail "提交里的 package.json 版本是 $commitVer，不是 $Version" }
Write-Host "已提交 $($head.Substring(0,7))，提交内版本 $commitVer"

Step '5/7 推送 main'
Ask '推送到 GitHub (origin main)?'
git push origin main
if ($LASTEXITCODE -ne 0) { Fail 'git push 失败' }

Step '6/7 打标签'
Ask "在 $($head.Substring(0,7)) 上打标签 $tag 并推送（会触发 GitHub Actions 三端打包发布）?"
git tag -a $tag $head -m $tag
if ($LASTEXITCODE -ne 0) { Fail 'git tag 失败' }
$tagTarget = (git rev-list -n 1 $tag).Trim()
if ($tagTarget -ne $head) { Fail "标签指向 $tagTarget，不是 $head" }
git push origin $tag
if ($LASTEXITCODE -ne 0) { Fail '推送标签失败' }

Step '7/7 完成'
Write-Host "$tag 已推送，打包约需 5-20 分钟:" -ForegroundColor Green
Write-Host '  https://github.com/xusofty-cyber/muse-ai-Desktop/actions'
Write-Host "  https://github.com/xusofty-cyber/muse-ai-Desktop/releases/tag/$tag"

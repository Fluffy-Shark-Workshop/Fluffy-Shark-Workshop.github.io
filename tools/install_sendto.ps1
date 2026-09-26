# 파일 탐색기의 [보내기] 메뉴에 "블로그에 올리기"를 추가합니다.
# 사용법: 이 파일을 마우스 오른쪽 버튼으로 누르고 [PowerShell에서 실행].
# 지우려면 Win+R 에 shell:sendto 를 입력해 열린 폴더에서 "블로그에 올리기"를 지우면 됩니다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Get-ChildItem -LiteralPath $root -Filter '*.bat' | Select-Object -First 1
if (-not $launcher) { throw "블로그 폴더에서 실행 파일(.bat)을 찾지 못했습니다: $root" }

$sendTo = [Environment]::GetFolderPath('SendTo')
$link = Join-Path $sendTo '블로그에 올리기.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $launcher.FullName
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,43"
$shortcut.Description = '선택한 파일로 블로그 글쓰기 도구를 엽니다'
$shortcut.Save()

Write-Host "추가했습니다: $link"
Write-Host "이제 파일을 고른 뒤 마우스 오른쪽 버튼 > 보내기 > 블로그에 올리기 를 누르면 됩니다."
Read-Host "Enter 키를 누르면 창이 닫힙니다"

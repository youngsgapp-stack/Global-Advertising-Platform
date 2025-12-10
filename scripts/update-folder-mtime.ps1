# 폴더 내 파일 변경 시 폴더의 수정 시간을 자동으로 업데이트하는 PowerShell 스크립트
#
# 사용법:
#   .\scripts\update-folder-mtime.ps1 [감시할 폴더 경로]
#
# 예시:
#   .\scripts\update-folder-mtime.ps1 .
#   .\scripts\update-folder-mtime.ps1 js
#   .\scripts\update-folder-mtime.ps1 docs

param(
    [string]$WatchPath = "."
)

$ErrorActionPreference = "Continue"

# 경로 정규화
$absolutePath = Resolve-Path -Path $WatchPath -ErrorAction Stop

if (-not (Test-Path -Path $absolutePath -PathType Container)) {
    Write-Host "❌ 경로가 존재하지 않거나 디렉토리가 아닙니다: $absolutePath" -ForegroundColor Red
    exit 1
}

# 무시할 패턴
$ignorePatterns = @(
    "node_modules",
    "\.git",
    "\.firebase",
    "\.cache",
    "\.vscode",
    "\.idea",
    "dist",
    "build",
    "coverage",
    "\.nyc_output",
    "\.log$",
    "\.tmp$",
    "\.bak$",
    "\.backup$",
    "\.old\.js$",
    "Thumbs\.db$",
    "desktop\.ini$",
    "\.DS_Store$"
)

function ShouldIgnore {
    param([string]$FilePath)
    
    foreach ($pattern in $ignorePatterns) {
        if ($FilePath -match $pattern) {
            return $true
        }
    }
    return $false
}

function Update-FolderMtime {
    param([string]$FolderPath)
    
    try {
        $now = Get-Date
        (Get-Item $FolderPath).LastWriteTime = $now
        $relativePath = $FolderPath.Replace($PWD.Path, "").TrimStart("\")
        if ([string]::IsNullOrEmpty($relativePath)) {
            $relativePath = "."
        }
        Write-Host "✅ 폴더 수정 시간 업데이트: $relativePath" -ForegroundColor Green
    } catch {
        Write-Host "❌ 폴더 수정 시간 업데이트 실패: $FolderPath - $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Handle-FileChange {
    param([string]$FilePath)
    
    if (ShouldIgnore -FilePath $FilePath) {
        return
    }
    
    $dir = Split-Path -Path $FilePath -Parent
    
    # 루트 디렉토리까지 모든 상위 폴더의 수정 시간 업데이트
    $currentDir = $dir
    $rootDir = $absolutePath
    
    while ($currentDir.Length -ge $rootDir.Length) {
        try {
            Update-FolderMtime -FolderPath $currentDir
            $parentDir = Split-Path -Path $currentDir -Parent
            
            # 루트 디렉토리에 도달하면 중단
            if ($parentDir -eq $currentDir -or $currentDir -eq $rootDir) {
                break
            }
            
            $currentDir = $parentDir
        } catch {
            # 권한 문제 등으로 상위 폴더 접근 불가 시 중단
            break
        }
    }
}

Write-Host "🔍 파일 변경 감시 시작: $absolutePath" -ForegroundColor Cyan
Write-Host "📝 파일이 변경되면 해당 폴더의 수정 시간이 자동으로 업데이트됩니다.`n" -ForegroundColor Yellow

# FileSystemWatcher 생성
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $absolutePath
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true

# 이벤트 핸들러
$action = {
    $details = $event.SourceEventArgs
    $name = $details.Name
    $changeType = $details.ChangeType
    $fullPath = $details.FullPath
    
    if (ShouldIgnore -FilePath $fullPath) {
        return
    }
    
    $relativePath = $fullPath.Replace($absolutePath, "").TrimStart("\")
    
    switch ($changeType) {
        "Created" {
            if (Test-Path -Path $fullPath -PathType Container) {
                Write-Host "📁 폴더 추가: $relativePath" -ForegroundColor Blue
            } else {
                Write-Host "📄 파일 추가: $relativePath" -ForegroundColor Blue
            }
            Handle-FileChange -FilePath $fullPath
        }
        "Changed" {
            # 폴더 변경 이벤트는 무시 (파일 변경만 처리)
            if (-not (Test-Path -Path $fullPath -PathType Container)) {
                Write-Host "✏️  파일 수정: $relativePath" -ForegroundColor Yellow
                Handle-FileChange -FilePath $fullPath
            }
        }
        "Deleted" {
            if (Test-Path -Path (Split-Path -Path $fullPath -Parent) -PathType Container) {
                Write-Host "🗑️  삭제: $relativePath" -ForegroundColor Red
                Handle-FileChange -FilePath $fullPath
            }
        }
        "Renamed" {
            Write-Host "🔄 이름 변경: $relativePath" -ForegroundColor Magenta
            Handle-FileChange -FilePath $fullPath
        }
    }
}

# 이벤트 등록
Register-ObjectEvent -InputObject $watcher -EventName "Created" -Action $action | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName "Changed" -Action $action | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName "Deleted" -Action $action | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName "Renamed" -Action $action | Out-Null

Write-Host "✅ 파일 감시 준비 완료`n" -ForegroundColor Green
Write-Host "종료하려면 Ctrl+C를 누르세요.`n" -ForegroundColor Yellow

try {
    # 무한 대기
    while ($true) {
        Start-Sleep -Seconds 1
    }
} finally {
    # 정리
    Write-Host "`n🛑 파일 감시를 종료합니다..." -ForegroundColor Yellow
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
}


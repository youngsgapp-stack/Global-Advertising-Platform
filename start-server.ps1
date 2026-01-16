# PowerShell HTTP Server for localhost:8000
# 포트 충돌 시 자동으로 다른 포트 사용
$port = 8000
$maxAttempts = 5
$listener = $null

for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$port/")
        $listener.Prefixes.Add("http://127.0.0.1:$port/")
        $listener.Start()
        Write-Host "✅ Successfully started on port $port" -ForegroundColor Green
        break
    } catch {
        if ($attempt -lt $maxAttempts) {
            Write-Host "⚠️ Port $port is in use, trying port $($port + 1)..." -ForegroundColor Yellow
            $port++
            if ($listener) {
                $listener = $null
            }
        } else {
            Write-Host "❌ Failed to start server after $maxAttempts attempts" -ForegroundColor Red
            Write-Host "Error: $_" -ForegroundColor Red
            exit 1
        }
    }
}

Write-Host "========================================" -ForegroundColor Green
Write-Host "Server started at http://localhost:$port/" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

$rootPath = $PSScriptRoot
if (-not $rootPath) {
    $rootPath = Get-Location
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $localPath = $request.Url.LocalPath
        if ($localPath -eq "/" -or $localPath -eq "") {
            $localPath = "/index.html"
        }
        
        $filePath = Join-Path $rootPath $localPath.TrimStart('/')
        
        if (Test-Path $filePath -PathType Leaf) {
            try {
                # 파일 정보 가져오기
                $fileInfo = Get-Item $filePath
                $contentLength = $fileInfo.Length
                
                # MIME type detection
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $mimeTypes = @{
                    ".html" = "text/html; charset=utf-8"
                    ".js" = "application/javascript; charset=utf-8"
                    ".css" = "text/css; charset=utf-8"
                    ".json" = "application/json; charset=utf-8"
                    ".png" = "image/png"
                    ".jpg" = "image/jpeg"
                    ".jpeg" = "image/jpeg"
                    ".gif" = "image/gif"
                    ".svg" = "image/svg+xml"
                    ".ico" = "image/x-icon"
                    ".woff" = "font/woff"
                    ".woff2" = "font/woff2"
                    ".ttf" = "font/ttf"
                    ".eot" = "application/vnd.ms-fontobject"
                }
                
                $response.ContentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
                $response.ContentLength64 = $contentLength
                
                # 파일 스트림을 직접 복사 (Content-Length 일치 보장)
                $fileStream = [System.IO.File]::OpenRead($filePath)
                try {
                    $fileStream.CopyTo($response.OutputStream)
                    $response.OutputStream.Flush()
                } finally {
                    $fileStream.Close()
                }
                
                Write-Host "$(Get-Date -Format 'HH:mm:ss') - 200 - $localPath ($contentLength bytes)" -ForegroundColor Green
            } catch {
                Write-Host "$(Get-Date -Format 'HH:mm:ss') - ERROR - $localPath : $_" -ForegroundColor Red
                $response.StatusCode = 500
                $errorMsg = [System.Text.Encoding]::UTF8.GetBytes("500 Internal Server Error")
                $response.ContentLength64 = $errorMsg.Length
                $response.ContentType = "text/plain; charset=utf-8"
                $response.OutputStream.Write($errorMsg, 0, $errorMsg.Length)
            }
        } else {
            $response.StatusCode = 404
            $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $localPath")
            $response.ContentLength64 = $notFound.Length
            $response.ContentType = "text/plain; charset=utf-8"
            $response.OutputStream.Write($notFound, 0, $notFound.Length)
            Write-Host "$(Get-Date -Format 'HH:mm:ss') - 404 - $localPath" -ForegroundColor Red
        }
        
        $response.Close()
    } catch {
        Write-Host "Error: $_" -ForegroundColor Red
    }
}

$listener.Stop()


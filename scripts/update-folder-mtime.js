/**
 * 폴더 내 파일 변경 시 폴더의 수정 시간을 자동으로 업데이트하는 스크립트
 * 
 * 사용법:
 *   node scripts/update-folder-mtime.js [감시할 폴더 경로]
 * 
 * 예시:
 *   node scripts/update-folder-mtime.js .
 *   node scripts/update-folder-mtime.js js
 *   node scripts/update-folder-mtime.js docs
 */

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

// 감시할 폴더 경로 (기본값: 현재 디렉토리)
const watchPath = process.argv[2] || '.';
const absolutePath = path.resolve(watchPath);

if (!fs.existsSync(absolutePath)) {
    console.error(`❌ 경로가 존재하지 않습니다: ${absolutePath}`);
    process.exit(1);
}

const stats = fs.statSync(absolutePath);
if (!stats.isDirectory()) {
    console.error(`❌ 디렉토리가 아닙니다: ${absolutePath}`);
    process.exit(1);
}

/**
 * 폴더의 수정 시간을 현재 시간으로 업데이트
 */
function updateFolderMtime(folderPath) {
    try {
        const now = new Date();
        fs.utimesSync(folderPath, now, now);
        console.log(`✅ 폴더 수정 시간 업데이트: ${path.relative(process.cwd(), folderPath)}`);
    } catch (error) {
        console.error(`❌ 폴더 수정 시간 업데이트 실패: ${folderPath}`, error.message);
    }
}

/**
 * 파일이 변경된 폴더의 수정 시간을 업데이트
 */
function handleFileChange(filePath) {
    const dir = path.dirname(filePath);
    
    // 루트 디렉토리까지 모든 상위 폴더의 수정 시간 업데이트
    let currentDir = dir;
    const rootDir = path.resolve(absolutePath);
    
    while (currentDir.length >= rootDir.length) {
        try {
            updateFolderMtime(currentDir);
            const parentDir = path.dirname(currentDir);
            
            // 루트 디렉토리에 도달하면 중단
            if (parentDir === currentDir || currentDir === rootDir) {
                break;
            }
            
            currentDir = parentDir;
        } catch (error) {
            // 권한 문제 등으로 상위 폴더 접근 불가 시 중단
            break;
        }
    }
}

console.log(`🔍 파일 변경 감시 시작: ${absolutePath}`);
console.log(`📝 파일이 변경되면 해당 폴더의 수정 시간이 자동으로 업데이트됩니다.\n`);

// 파일 감시 시작
const watcher = chokidar.watch(absolutePath, {
    ignored: [
        /(^|[\/\\])\../, // 숨김 파일/폴더
        /node_modules/,
        /\.git/,
        /\.firebase/,
        /\.cache/,
        /\.vscode/,
        /\.idea/,
        /dist/,
        /build/,
        /coverage/,
        /\.nyc_output/,
        /\.log$/,
        /\.tmp$/,
        /\.bak$/,
        /\.backup$/,
        /\.old\.js$/,
        /Thumbs\.db$/,
        /desktop\.ini$/,
        /\.DS_Store$/
    ],
    persistent: true,
    ignoreInitial: false, // 초기 스캔 시에도 이벤트 발생
    awaitWriteFinish: {
        stabilityThreshold: 100, // 100ms 동안 변경이 없으면 안정화된 것으로 간주
        pollInterval: 50
    }
});

// 파일 변경 이벤트 처리
watcher
    .on('add', filePath => {
        console.log(`📄 파일 추가: ${path.relative(process.cwd(), filePath)}`);
        handleFileChange(filePath);
    })
    .on('change', filePath => {
        console.log(`✏️  파일 수정: ${path.relative(process.cwd(), filePath)}`);
        handleFileChange(filePath);
    })
    .on('unlink', filePath => {
        console.log(`🗑️  파일 삭제: ${path.relative(process.cwd(), filePath)}`);
        handleFileChange(filePath);
    })
    .on('addDir', dirPath => {
        console.log(`📁 폴더 추가: ${path.relative(process.cwd(), dirPath)}`);
        handleFileChange(dirPath);
    })
    .on('unlinkDir', dirPath => {
        console.log(`🗑️  폴더 삭제: ${path.relative(process.cwd(), dirPath)}`);
        handleFileChange(dirPath);
    })
    .on('error', error => {
        console.error(`❌ 감시 중 오류 발생:`, error);
    })
    .on('ready', () => {
        console.log(`✅ 파일 감시 준비 완료\n`);
    });

// 종료 시 정리
process.on('SIGINT', () => {
    console.log('\n\n🛑 파일 감시를 종료합니다...');
    watcher.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    watcher.close();
    process.exit(0);
});


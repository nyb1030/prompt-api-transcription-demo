// 1. UI Elements
const startAudioSessionButton = document.querySelector("#start-audio-session");
const stopAudioSessionButton = document.querySelector("#stop-audio-session");
const logs = document.querySelector("#logs");
const timerDisplay = document.querySelector("#timer-display");
// Updated: Targeting the content holders within the two summary divs
const currentSummaryContentDesktop = document.querySelector("#summary-content-desktop");
const currentSummaryContentMobile = document.querySelector("#summary-content-mobile");

// 2. State Variables
let isRecording = false;
let currentAudioStream = null;
let timerInterval = null;
let elapsedSeconds = 0;

// Global array to store all transcribed text
const ALL_TRANSCRIPTIONS = [];
// Array to hold all concurrent processing promises
let processingPromises = [];

window.onload = async () => {
    const availability = await LanguageModel.availability();

    if (availability !== "available") {
        alert("Gemini Nano is not downloaded. Please wait for download. Refresh screen after download.");
        const downloadProgressDiv = document.querySelector(".download-progress");

        await LanguageModel.create({
            monitor(m) {
                m.addEventListener('downloadprogress', (e) => {
                    console.log(`Downloaded ${e.loaded * 100}%`);
                    downloadProgressDiv.innerHTML = `Downloaded ${Math.round(e.loaded * 100)}%`;
                });
            },
        });
    }
}



// --- Utility Functions ---


// Helper function to create and append logs to a specified parent (or default 'logs')
function appendLog(content, tag = 'p', className = '', parentElement = logs) {
    const element = document.createElement(tag);
    // Apply Tailwind styles based on the type/class
    let tailwindClasses = '';

    if (tag === 'h2') {
        tailwindClasses = 'text-lg font-semibold text-gray-700 mt-4 mb-2 border-b pb-1';
    } else if (tag === 'h3') {
        // Segment Header
        tailwindClasses = 'text-base font-semibold text-primary';
    } else if (className.includes('error')) {
        tailwindClasses = 'text-red-600 font-medium bg-red-50 p-2 rounded-lg';
    } else if (className.includes('success')) {
        tailwindClasses = 'text-secondary font-medium';
    }

    element.className = tailwindClasses + (className ? ' ' + className : '');

    if (typeof content === 'string') {
        element.textContent = content;
    } else {
        element.append(content);
    }
    parentElement.append(element);
    logs.scrollTop = logs.scrollHeight;
}

function updateTimerUI() {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const paddedSeconds = seconds < 10 ? '0' + seconds : seconds;
    const totalMinutes = 15;

    // Update timer color based on remaining time (e.g., flash red near the limit)
    const remainingSeconds = 900 - elapsedSeconds;
    const timerClass = remainingSeconds <= 60 ? 'text-red-500' : 'text-primary';
    const bgClass = remainingSeconds <= 60 ? 'bg-red-50' : 'bg-indigo-50';

    timerDisplay.textContent = `${minutes}:${paddedSeconds} seconds / ${totalMinutes} min`;
    timerDisplay.className = `text-3xl font-extrabold ${timerClass} mb-6 p-2 ${bgClass} rounded-lg text-center`;

    if (elapsedSeconds >= 900) {
        stopAudioSession();
    }
}

function startTimer() {
    elapsedSeconds = 0;
    updateTimerUI();
    timerInterval = setInterval(() => {
        if (isRecording) {
            elapsedSeconds++;
            updateTimerUI();
        }
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
}

// Function to stop the recording session
function stopAudioSession() {
    if (isRecording) {
        isRecording = false;
        stopTimer();
        appendLog('セッションを停止しています...', 'h2');
        currentAudioStream?.getTracks().forEach((track) => track.stop());
        currentAudioStream = null;
        appendLog('ユーザーによって録音が停止されました。', 'h2');

        startAudioSessionButton.disabled = false;
        stopAudioSessionButton.disabled = true;
    }
}

// --- Core Session Logic ---

async function startContinuousAudioSession() {
    if (isRecording) {
        appendLog('録音セッションがすでにアクティブです。', 'p', 'error');
        return;
    }

    // Clear previous data
    ALL_TRANSCRIPTIONS.length = 0;
    processingPromises = [];
    logs.innerHTML = '<p class="text-gray-500 italic">ログはここに表示されます。</p>'; // Clear logs for new session
    const initialSummary = '<p class="text-gray-500 italic">録音を開始すると、要約がここにリアルタイムで更新されます。</p>';
    currentSummaryContentDesktop.innerHTML = initialSummary;
    currentSummaryContentMobile.innerHTML = initialSummary;

    const TOTAL_DURATION_SECONDS = 900; // 15 minutes, could be adjusted as needed
    const SEGMENT_DURATION_SECONDS = 30; // Max duration is 30 sec
    const NUMBER_OF_SEGMENTS = TOTAL_DURATION_SECONDS / SEGMENT_DURATION_SECONDS;

    isRecording = true;
    startAudioSessionButton.disabled = true;
    stopAudioSessionButton.disabled = false;

    startTimer();

    try {
        // 1. Request audio stream once at the start
        currentAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        appendLog('15分間の連続録音を開始します...', 'h2');

        // Clear initial placeholder log
        if (logs.querySelector('p')?.textContent.includes('ログはここに表示されます')) {
            logs.innerHTML = '';
        }

        for (let i = 0; i < NUMBER_OF_SEGMENTS; i++) {
            // Exit the loop if the stop button was pressed or time exceeded
            if (!isRecording || elapsedSeconds >= TOTAL_DURATION_SECONDS) {
                appendLog('セッションが手動で停止されました、または最大時間に達しました。', 'p', 'error');
                break;
            }

            const segmentNumber = i + 1;
            const segmentStartTime = i * SEGMENT_DURATION_SECONDS;

            // Create a container for this segment's logs
            const segmentContainer = document.createElement('div');
            segmentContainer.classList.add('segment-container', 'bg-white', 'p-4', 'rounded-lg', 'shadow-sm', 'border', 'border-gray-200', 'mb-4');
            segmentContainer.id = `segment-${segmentNumber}-container`;
            logs.prepend(segmentContainer); // Prepend so new segments appear at the top

            appendLog(`セグメント ${segmentNumber}/${NUMBER_OF_SEGMENTS} (時間: ${segmentStartTime}秒 - ${segmentStartTime + 30}秒)`, 'h3', '', segmentContainer);

            // 2. Start recording the segment (30s)
            const blob = await recordSingleSegment(currentAudioStream, SEGMENT_DURATION_SECONDS * 1000);

            // 3. Immediately queue the transcription and processing as a Promise, passing the container
            const processingPromise = processSegment(blob, segmentNumber, segmentContainer);
            processingPromises.push(processingPromise);

            appendLog(`✅ 音声が録音されました。バックグラウンドで処理中...`, 'p', 'success text-sm italic', segmentContainer);
        }

        // 4. WAIT for all background processing to finish

        if (processingPromises.length > 0) {
            let message;

            // If isRecording is TRUE here, it means the loop ran to completion (30 segments) without the Stop button being hit.
            if (isRecording) {
                message = 'すべてのセグメントが録音されました。バックグラウンドの文字起こしが完了するのを待っています...';
            } else {
                // If isRecording is FALSE, the user manually stopped, and we are waiting for any queued jobs to finish.
                message = 'キュー内の残りのセグメント処理が完了するのを待っています...';
            }

            appendLog(message, 'h2');
            await Promise.all(processingPromises);
        }

        // Since continuous summary is active, no final summary is needed.
        if (isRecording || processingPromises.length > 0) {
            appendLog('プロセス完了。', 'h2');
        }

    } catch (error) {
        console.error("セッション中にエラーが発生しました:", error);
        appendLog(`エラー: ${error.message}`, 'p', 'error');
    } finally {
        // Cleanup regardless of loop completion or error
        stopAudioSession();
        updateTimerUI(); // Reset visual state
    }
}

// Encapsulates the transcription and storage logic
async function processSegment(blob, segmentNumber, segmentContainer) {
    try {
        appendLog(`文字起こしを開始しています...`, 'p', 'text-sm text-gray-600', segmentContainer);

        // 1. Transcribe the segment
        const transcription = await transcribe(blob, segmentNumber, segmentContainer);

        // 2. Save the transcription
        ALL_TRANSCRIPTIONS.push(transcription);

        // 3. Generate and display the segment summary (NEW)
        await generateSegmentSummary(transcription);

        appendLog(`文字起こしと要約が保存/更新されました。`, 'p', 'text-xs text-secondary italic', segmentContainer);

    } catch (e) {
        console.error(`セグメント ${segmentNumber} の処理中にエラー:`, e);
        appendLog(`エラー: セグメント ${segmentNumber} の処理中にエラーが発生しました: ${e.message}`, 'p', 'error', segmentContainer);
        ALL_TRANSCRIPTIONS.push("");
    }
}

// Helper function to record a single 30-second segment (No changes)
function recordSingleSegment(audioStream, durationMs) {
    return new Promise((resolve) => {
        const chunks = [];
        const recorder = new MediaRecorder(audioStream);

        recorder.ondataavailable = ({ data }) => {
            chunks.push(data);
        };

        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: recorder.mimeType });
            resolve(blob);
        };

        // Start recording and stop after the durationMs
        recorder.start();
        setTimeout(() => {
            if (recorder.state !== 'inactive') {
                recorder.stop();
            }
        }, durationMs);
    });
}

// Transcribe function: returns the transcribed text
async function transcribe(blob, segmentNumber, parentElement) {
    const arrayBuffer = await blob.arrayBuffer();
    const inputLanguage = document.querySelector("#input-language").value;
    const outputLanguage = document.querySelector("#output-language").value;
    const availability = await LanguageModel.availability();
    let audioSession;

    // API Call Setup (assuming LanguageModel is defined)
        const params = await LanguageModel.params();
        audioSession = await LanguageModel.create({
            expectedInputs: [{ type: "audio", languages: [inputLanguage] }],
            expectedOutputs: [{ type: "text", languages: [outputLanguage] }]
        });

        const audioStream = audioSession.promptStreaming([
            {
                role: "user",
                content: [
                    { type: "text", value: "音声を文字起こしして。" },
                    { type: "audio", value: arrayBuffer },
                ],
            },
        ]);

        const transcriptionContainer = document.createElement('div');
        transcriptionContainer.classList.add('segment-log', 'p-3', 'mt-2');

        const transcriptionHeader = document.createElement('h4');
        transcriptionHeader.textContent = `文字起こし出力:`;
        transcriptionHeader.classList.add('text-sm', 'font-medium', 'text-gray-800', 'mb-1');
        transcriptionContainer.append(transcriptionHeader);

        const transcriptionTextElement = document.createElement('p');
        transcriptionTextElement.classList.add('text-gray-700', 'whitespace-pre-wrap');
        let transcriptionText = '';

        for await (const chunk of audioStream) {
            transcriptionText += chunk;
            transcriptionTextElement.textContent = transcriptionText;

            if (!transcriptionContainer.contains(transcriptionTextElement)) {
                transcriptionContainer.append(transcriptionTextElement);
            }
        }

        parentElement.append(transcriptionContainer);
        logs.scrollTop = 0; // Scroll to top for new segment visibility (since we are prepending)

        return transcriptionText;
    }
// NEW FUNCTION: Generates summary of the segment and updates the current-summary div
async function generateSegmentSummary(transcribedText) {

    const fullText = ALL_TRANSCRIPTIONS.join('\n\n--- SEGMENT BREAK ---\n\n');

    const summaryContentElements = [currentSummaryContentDesktop, currentSummaryContentMobile];

    if (fullText.trim().length === 0) {
        const noText = '<p class="text-gray-500 italic">要約するテキストがまだありません。</p>';
        summaryContentElements.forEach(el => el.innerHTML = noText);
        return;
    }

    const loadingText = '<div class="flex items-center space-x-2 text-primary"><svg class="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><p>要約を生成しています...</p></div>';
    summaryContentElements.forEach(el => el.innerHTML = loadingText);

    const summaryTextElement = document.createElement('div');
    summaryTextElement.classList.add('text-gray-700', 'prose', 'prose-sm', 'max-w-none'); // Using prose for markdown formatting

    try {
        // Placeholder for the summary session creation (using LanguageModel for demo)
        const summaryModel = await LanguageModel.create({
            expectedInputs: [{ type: "text", languages: ["ja"] }],
            expectedOutputs: [{ type: "text", languages: ["ja"] }]
        });

        // Prompt the model to summarize ALL transcribed content so far
        const summaryStream = summaryModel.promptStreaming([
            {
                role: "user",
                content: [
                    { type: "text", value: `これまでの全ての会話内容を考慮して、全体の要点を3つの箇条書きで要約してください。要約以外の内容は返さないでください。\n\n${fullText}` },
                ],
            },
        ]);

        let summaryText = '';
        for await (const chunk of summaryStream) {
            summaryText += chunk;
            // Set innerHTML to interpret markdown/list formatting from the model
            summaryTextElement.innerHTML = summaryText.replace(/\n/g, '<br>');
        }

        // Replace the placeholder content with the final summary in both desktop and mobile views
        summaryContentElements.forEach(el => {
            el.innerHTML = ''; // Clear loading state
            el.append(summaryTextElement.cloneNode(true)); // Use cloneNode(true) to avoid moving the element
        });


    } catch (e) {
        const errorMsg = `<p class="text-red-600 italic">要約の更新エラー: ${e.message}</p>`;
        summaryContentElements.forEach(el => el.innerHTML = errorMsg);
    }
}


// --- Event Listeners ---
startAudioSessionButton.addEventListener("click", async () => { await startContinuousAudioSession(); });
stopAudioSessionButton.addEventListener("click", () => { stopAudioSession(); });

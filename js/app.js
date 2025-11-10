(function (exports) {
    const numSubClients = 4;
    let targetBufferSeconds = 12; // Start with 7.5 seconds behind live
    let consecutiveStalls = 0;
    let consecutiveOutOfOrderSegmentReceived = 0;
    const MAX_OUT_OF_ORDER_BEFORE_SKIP = 10;
    const MIN_BUFFER = 8;
    const MAX_BUFFER = 16;

    class StreamApp {
        async startApp(startupWallet, novioClient) {
            // Initialize the debugger
            const streamDebugger = new LivestreamDebugger();

            document.getElementById("login-popup").style.display = "none";
            document.getElementById("connection-indicator").style.display = 'block';

            const chatbox = document.getElementById('chatbox');
            const messagesBox = document.getElementById('messagesBox');
            const chatInput = document.getElementById('chat-input');
            const collapseBtn = document.getElementById('collapse-btn');
            const chatPopoutBtn = document.getElementById('chat-popout-btn');
            const contentContainer = document.querySelector('.content-container');
            const streamPreviewContainer = document.querySelector('.stream-preview-container');

            const chatProgressLine = document.querySelector('.progress-line')
            const chatDonateButton = document.querySelector('.donate-button')
            const chatDonatePopup = document.querySelector('.donate-popup')
            const chatDonateAmount = document.querySelector('.donate-amount')
            const chatWalletBalance = document.querySelector('.wallet-balance')
            const chatErrorMessage = document.querySelector('.error-message')

            const pointsRewardBot = '50000f2c6c8f1bedb037b99adff9df67d6d00c818c326e6e72af0779bf5e6879'

            var chatPopoutWindow;
            let isCollapsed = false;

            const appendSemaphore = new Semaphore(1);

            var client = null;
            var firstChunk = true;
            let nextSegmentId = 0;
            const pendingSegments = new Map();

            var currentSessionId = -1;
            var watchingStreamAddress = '';

            var video = null;
            var sourceBuffer = null;
            var transmuxer = null;


            var segments = {};
            const CHUNK_SIZE = 64000;

            var streamViewers = {};
            var streamPreviews = {};

            // Replace this value with your files codec info
            const mime = 'video/mp4; codecs="mp4a.40.2,avc1.64001f"';
            var isPlaying = false;
            var segmentsBehind = 0;

            const donationRegex = /donate[0-9]+/g
            const txFee = 0.1;
            var walletBalance = 0;
            var messageDonationTotal = 0;

            let maxChars = 500;
            let addressbook = {};

            let isGuest = true;
            var qualityChangedSegmentId = -1;

            let currentS2Points = 0;

            if (window.innerWidth < 640) {
                collapseChat();
            }

            if (window.mobileAndTabletCheck() == true) {
                chatPopoutBtn.style.display = 'none';
            }

            if (novioClient != undefined) {
                //TODO: FIGURE OUT WHAT WALLET IS USED FOR AND IF NOVIO SUPPORTS THOSE FUNCS.
                //UHM NO WALLET!??
                wallet = new nkn.Wallet({});
            } else {
                var wallet = null;
                if (startupWallet != null) {
                    wallet = startupWallet;
                    isGuest = false;
                } else {
                    wallet = new nkn.Wallet({});
                }
            }

            var myRole = '';
            var adaptiveQuality = null;

            getAddressbook()

            videojs('streamPlayer').posterImage.setSrc("./images/favicon.svg");
            videojs('streamPlayer').posterImage.show();
            videojs('streamPlayer').bigPlayButton.hide();

            // Adding button to the control bar
            var index = videojs.players.streamPlayer.controlBar.children().length - 2
            var myButton = videojs.players.streamPlayer.controlBar.addChild('button', {}, index);

            // Create our button's DOM Component
            var qualityLevelsElement = myButton.el();

            qualityLevelsElement.style.width = "auto";

            qualityLevelsElement.innerHTML = `<select style="display:block; height: auto; border:0" name="qualityControl" id="qualityControl"></select>`;

            document.getElementById("qualityControl").onchange = async (e) => {
                var replySegmentId = await client.send(watchingStreamAddress, 'quality' + e.target.value);
                qualityChangedSegmentId = replySegmentId;
            }

            if (novioClient == undefined) {
                const nknClient = new NknClient(wallet);
                client = await nknClient.Setup();
            } else {
                client = novioClient;
            }

            document.getElementById('connection-indicator').style.display = 'none';
            document.getElementById('blackoutPanel').style.display = 'none';

            window.onbeforeunload = () => {
                if (chatPopoutWindow != null) {
                    chatPopoutWindow.close();
                }
            }

            setInterval(() => {
                if (watchingStreamAddress != '') {
                    client.send(watchingStreamAddress, 'ping', { noReply: true });
                    client.send(watchingStreamAddress, 'viewcount').then((reply => {
                        streamViewers[watchingStreamAddress] = reply;
                        document.getElementById('viewCount').innerHTML = reply;
                    })).catch((err) => {
                        if (streamPreviews[watchingStreamAddress] != null) {
                            streamPreviewContainer.removeChild(streamPreviews[watchingStreamAddress]);
                            delete streamPreviews[watchingStreamAddress];
                        }
                        document.getElementById('viewCount').innerHTML = 'offline';
                    });

                    const getTotalPointsMessage = {
                        type: 'get_total_points',
                        timestamp: Date.now()
                    }

                    client.send(pointsRewardBot, JSON.stringify(getTotalPointsMessage), {
                        noReply: true,
                        responseTimeout: 5000
                    });

                    client.send(pointsRewardBot, JSON.stringify({
                        type: 'heartbeat',
                        streamer: watchingStreamAddress,
                        timestamp: Date.now()
                    }), {
                        noReply: true,
                        responseTimeout: 5000
                    });
                }
            }, 10000);

            getStreamers();
            setInterval(() => {
                getStreamers()
            }, 30000);


            // Poll buffer status regularly:
            setInterval(() => {
                if (sourceBuffer && video) {
                    streamDebugger.updateTargetBuffer(targetBufferSeconds);
                    streamDebugger.updateBufferMetrics(video, sourceBuffer);
                }
            }, 500);

            //Singe page logic
            const currentPath = window.location.pathname.substring(1);
            if (currentPath.length > 0) {
                watchStream(currentPath);
            } else {
                document.getElementById('previewContainer').style.display = 'block';
            }
            window.addEventListener("popstate", function (event) {
                // Get the new URL from the event
                const newUrl = window.location.pathname.substring(1)
                document.getElementById('panelContainer').innerHTML = ''

                if (newUrl.length > 0) {
                    watchStream(newUrl);
                } else {
                    document.getElementById('previewContainer').style.display = 'block';
                }
            });

            document.getElementById("dashboardButton").onclick = () => {
                history.pushState({}, '', '/')
                var popStateEvent = new PopStateEvent('popstate', { state: {} });
                dispatchEvent(popStateEvent);
            }

            client.onMessage(({ src, payload }) => {
                if (src == pointsRewardBot) {
                    try {
                        var payloadObj = JSON.parse(payload);

                        if (payloadObj['content'] != undefined) {
                            msgObj = JSON.parse(payloadObj['content']);
                        } else {
                            msgObj = JSON.parse(payloadObj);
                        }

                        if (msgObj.type == "reward_notification") {
                            const points = msgObj.points;
                            currentS2Points += points;
                            showRewardNotification(points, currentS2Points, msgObj.balanceMultiplier, msgObj.nextTierMultiplier, msgObj.nextTierNknRequired);
                            document.getElementById("SeasonTwoPoints").innerText = currentS2Points;
                            lastReward = Date.now();
                        }
                        else if (msgObj.type == "total_points_response") {
                            const points = msgObj.totalPoints;
                            if (currentS2Points != points) {
                                const delta = points - currentS2Points;
                                showRewardNotification(delta, points, msgObj.balanceMultiplier, msgObj.nextTierMultiplier, msgObj.nextTierNknRequired);
                                currentS2Points = points;
                                lastReward = Date.now();
                            }
                            document.getElementById("SeasonTwoPoints").innerText = points;
                        } else {
                            debugger;
                            console.log("Unknown type from bot:" + msgObj);
                        }
                    } catch {
                        if (lastReward == undefined) {
                            setNextRewardProgress(0.0);
                            lastReward = Date.now();
                        } else {
                            //5 minutes = 1000ms * 300 sec.
                            const progress = (Date.now() - lastReward) / 1000.0 / 300.0;
                            setNextRewardProgress(progress);
                        }
                    }
                }
                if (watchingStreamAddress == '') {
                    return;
                }
                let watchingStreamAddressFromUsername = '';
                if (addressbook[src] != null) {
                    watchingStreamAddressFromUsername = addressbook[src].public_key;
                }
                if (src != watchingStreamAddress && src != watchingStreamAddressFromUsername) {
                    return;
                }
                if (typeof payload == 'object' || payload instanceof Uint8Array) {

                    //If its an object we parse it to Uint8Array this is because chrome runtime messaging serialized the msg.
                    payload = new Uint8Array(Object.values(payload));

                    if (isChatMessage(payload)) {
                        const chatMsg = uint8ArrayToJsonString(payload)
                        //if (chatMsg.src != client.addr) {
                        addMessage(chatMsg)
                        //}
                        return;
                    }

                    handleChunk(payload, (id, data) => {
                        if (firstChunk) {
                            appendFirstSegment(data);
                            nextSegmentId = id + 1;
                            firstChunk = false;

                            chatInput.setAttribute('contenteditable', true);
                            chatDonateButton.style.display = 'block';
                            chatInput.textContent = '';

                            console.log("FIRST SEGMENT APPENDED | EXPECTING: " + nextSegmentId);
                            return;
                        }
                        else if (id === qualityChangedSegmentId) {
                            appendFirstSegment(data);
                            nextSegmentId = id + 1;
                            console.log("QUALITY SEGMENT APPENDED | EXPECTING: " + nextSegmentId);
                            return;
                        }

                        if (id < nextSegmentId) {
                            console.log("DUPLICATE SEGMENT RECEIVED, IGNORE | EXPECTING: " + nextSegmentId);
                            return;
                        }

                        if (id > nextSegmentId) {
                            // Out of order — store for later
                            pendingSegments.set(id, data);
                            consecutiveOutOfOrderSegmentReceived++;

                            console.log(`OUT OF ORDER SEGMENT ${id} RECEIVED | EXPECTING: ${nextSegmentId}`);

                            // Too many consecutive out-of-order segments → skip ahead
                            if (consecutiveOutOfOrderSegmentReceived >= MAX_OUT_OF_ORDER_BEFORE_SKIP) {
                                console.warn(
                                    `SKIPPING AHEAD after ${MAX_OUT_OF_ORDER_BEFORE_SKIP} misses | Was expecting ${nextSegmentId}, jumping to ${id}`
                                );

                                // Find the lowest available pending segment >= id
                                const sortedIds = [...pendingSegments.keys()].sort((a, b) => a - b);
                                const nextAvailableId = sortedIds.find(sid => sid >= id);
                                if (nextAvailableId == null) {
                                    console.warn("No pending segments to skip to — waiting for more data");
                                    return;
                                }

                                const nextData = pendingSegments.get(nextAvailableId);
                                pendingSegments.clear(); // reset pending
                                appendFirstSegment(nextData); // restart playback chain
                                nextSegmentId = nextAvailableId + 1;
                                consecutiveOutOfOrderSegmentReceived = 0;
                                console.log(`SKIP AHEAD SEGMENT ${nextAvailableId} APPENDED AS FIRST | EXPECTING: ${nextSegmentId}`);

                                // Continue with any immediately following segments
                                while (pendingSegments.has(nextSegmentId)) {
                                    const nextData = pendingSegments.get(nextSegmentId);
                                    pendingSegments.delete(nextSegmentId);
                                    appendNextSegment(nextData);
                                    nextSegmentId++;
                                    console.log("PENDING SEGMENT APPENDED | EXPECTING: " + nextSegmentId);
                                }
                            }
                            return;
                        }

                        // id == nextSegmentId → append now
                        appendNextSegment(data);
                        nextSegmentId++;
                        consecutiveOutOfOrderSegmentReceived = 0;
                        console.log("SEGMENT APPENDED | EXPECTING: " + nextSegmentId);

                        // Flush any queued segments in order
                        while (pendingSegments.has(nextSegmentId)) {
                            const nextData = pendingSegments.get(nextSegmentId);
                            pendingSegments.delete(nextSegmentId);
                            appendNextSegment(nextData);
                            nextSegmentId++;
                            console.log("PENDING SEGMENT APPENDED | EXPECTING: " + nextSegmentId);
                        }
                    });
                } else {
                    var msgObj = JSON.parse(payload);
                    if (msgObj.type == 'delete-chat-message') {
                        deleteMessage(msgObj.content.msgId);
                    }
                }
            });

            function handleChunk(data, onSegmentComplete) {
                const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                const dv = new DataView(arrayBuffer);

                const sessionId = dv.getUint32(0, true);
                const segmentId = dv.getUint32(4, true);
                const chunkId = dv.getUint32(8, true);
                const totalChunks = dv.getUint32(12, true);
                const chunkSize = dv.getUint32(16, true);
                const headerSize = 20;

                // Drop chunks from old sessions
                if (sessionId < currentSessionId) {
                    console.warn(`Ignoring chunk from old session ${sessionId} (expected ${currentSessionId})`);
                    return;
                }
                if (sessionId > currentSessionId) {
                    firstChunk = true;
                    currentSessionId = sessionId;
                    console.warn(`New session has been started ${sessionId} removing old segments`);
                    segments = {};
                    pendingSegments.clear(); // reset pending
                }

                if (segmentId < nextSegmentId) {
                    console.warn(`Ignoring chunk from segment ${segmentId} older than current active segment ${nextSegmentId}`);
                    for (const idStr of Object.keys(segments)) {
                        const id = Number(idStr);
                        if (id < nextSegmentId) {
                            console.warn(`Deleting old segment ${id} (older than current active segment ${nextSegmentId})`);
                            delete segments[id];
                        }
                    }
                    return;
                }

                // Initialize this segment if needed
                if (!segments[segmentId]) {
                    segments[segmentId] = {
                        data: new Uint8Array(totalChunks * chunkSize),
                        chunksReceived: 0,
                        totalChunks,
                        chunkSize,
                        bytesReceived: 0,
                        received: new Array(totalChunks).fill(false)
                    };
                }

                const segment = segments[segmentId];
                const dataSlice = new Uint8Array(arrayBuffer, headerSize);

                // Store chunk
                segment.data.set(dataSlice, chunkId * chunkSize);
                if (!segment.received[chunkId]) {
                    segment.received[chunkId] = true;
                    segment.chunksReceived++;
                }
                segment.bytesReceived += dataSlice.length;

                // Update debug overlay
                updateDebugView();

                // If all chunks have arrived, deliver the segment
                if (segment.chunksReceived === segment.totalChunks) {
                    onSegmentComplete(segmentId, segment.data.slice(0, segment.bytesReceived));
                    delete segments[segmentId];
                    updateDebugView();
                }
            }

            async function appendFirstSegment(chunk) {
                await appendSemaphore.acquire()
                try {
                    streamDebugger.onSegmentReceived(chunk.byteLength);

                    let mediaSource = new MediaSource();
                    transmuxer = new muxjs.mp4.Transmuxer();

                    video = document.querySelector('video');

                    video.src = URL.createObjectURL(mediaSource);
                    videojs('streamPlayer').controlBar.progressControl.hide();

                    videojs('streamPlayer').on(['waiting', 'pause'], () => {
                        isPlaying = false;
                        streamDebugger.onPlaybackStateChange(false);
                    });
                    videojs('streamPlayer').on('playing', function () {
                        streamDebugger.onPlaybackStateChange(true);
                        isPlaying = true;
                        segmentsBehind = 0;

                        // Speed up slightly if behind
                        const bufferAhead = sourceBuffer.buffered.length > 0
                            ? sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) - video.currentTime
                            : 0;

                        if (bufferAhead < 3) {
                            video.playbackRate = 1.0; // Normal when low buffer
                        } else if (bufferAhead > 8) {
                            video.playbackRate = 1.05; // Slightly faster to catch up
                        }

                        // If you adjust playback rate:
                        if (video.playbackRate !== 1.0) {
                            streamDebugger.onPlaybackRateChange(video.playbackRate);
                        }
                    });

                    const waitForOpen = new Promise((resolve) => {
                        mediaSource.addEventListener("sourceopen", resolve);
                    })

                    await waitForOpen;

                    URL.revokeObjectURL(video.src);

                    sourceBuffer = mediaSource.addSourceBuffer(mime);
                    sourceBuffer.addEventListener('updateend', async () => {

                        streamDebugger.updateBufferMetrics(video, sourceBuffer);
                        streamDebugger.updateSourceBufferState(false);

                        if (!isPlaying) {
                            consecutiveStalls++;

                            // Increase buffer target when stalling frequently
                            if (consecutiveStalls > 2) {
                                targetBufferSeconds = Math.min(targetBufferSeconds + 1, MAX_BUFFER);
                                consecutiveStalls = 0;
                            }

                            // Only seek if we're VERY far behind AND have enough buffer ahead
                            const currentTime = video.currentTime;
                            const bufferedEnd = sourceBuffer.buffered.length > 0
                                ? sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
                                : 0;
                            const bufferAhead = bufferedEnd - currentTime;

                            if (segmentsBehind > 5 && bufferAhead > targetBufferSeconds) {
                                // Seek to a point that maintains our target buffer
                                video.currentTime = bufferedEnd - targetBufferSeconds;
                                segmentsBehind = 0;
                                consecutiveStalls = 0;
                            }

                            segmentsBehind++;
                        } else {
                            // Playing smoothly - gradually reduce buffer target
                            if (consecutiveStalls > 0) consecutiveStalls--;
                            if (targetBufferSeconds > MIN_BUFFER) {
                                targetBufferSeconds = Math.max(targetBufferSeconds - 0.1, MIN_BUFFER);
                            }
                        }

                        // Buffer cleanup
                        for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                            const bufferStart = sourceBuffer.buffered.start(i);
                            const bufferEnd = sourceBuffer.buffered.end(i);
                            const bufferLength = bufferEnd - bufferStart;

                            if (bufferLength > 60) {
                                const safeRemoveEnd = Math.min(
                                    bufferEnd - 30,
                                    video.currentTime - 5  // Never remove within 5s of playback
                                );

                                // Only remove if there's actually something safe to remove
                                if (safeRemoveEnd > bufferStart) {
                                    sourceBuffer.remove(bufferStart, safeRemoveEnd);
                                    while (sourceBuffer.updating) {
                                        await new Promise(r => setTimeout(r, 1));
                                    }
                                }
                            }
                        }
                    });

                    sourceBuffer.addEventListener('update', () => {
                        streamDebugger.updateSourceBufferState(true);
                    });

                    transmuxer.on('data', async (segment) => {
                        let data = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
                        data.set(segment.initSegment, 0);
                        data.set(segment.data, segment.initSegment.byteLength);
                        while (sourceBuffer.updating) {
                            await new Promise(r => setTimeout(r, 1));
                        }
                        sourceBuffer.appendBuffer(data);
                        // reset the 'data' event listener to just append (moof/mdat) boxes to the Source Buffer
                        transmuxer.off('data');
                    })
                    transmuxer.push(chunk);
                    transmuxer.flush();
                }
                finally {
                    appendSemaphore.release()
                }
            }

            function appendNextSegment(chunk) {
                transmuxer.on('data', async (segment) => {
                    await appendSemaphore.acquire()

                    streamDebugger.onSegmentReceived(chunk.byteLength);
                    const appendStart = performance.now();
                    try {
                        while (sourceBuffer.updating) {
                            await new Promise(r => setTimeout(r, 1));
                        }
                        sourceBuffer.appendBuffer(new Uint8Array(segment.data));

                        const appendDuration = performance.now() - appendStart;
                        streamDebugger.onSegmentAppended(appendDuration);

                        transmuxer.off('data');
                    }
                    finally {
                        appendSemaphore.release()
                    }
                })
                transmuxer.push(chunk);
                transmuxer.flush();
            }

            // note: `buffer` arg can be an ArrayBuffer or a Uint8Array
            async function bufferToBase64(buffer) {
                // use a FileReader to generate a base64 data URI:
                const base64url = await new Promise(r => {
                    const reader = new FileReader()
                    reader.onload = () => r(reader.result)
                    reader.readAsDataURL(new Blob([buffer]))
                });
                // remove the `data:...;base64,` part from the start
                return base64url.slice(base64url.indexOf(',') + 1);
            }

            sizeVideo();
            window.onresize = () => {
                sizeVideo();
            };

            function sizeVideo() {
                const el = document.querySelector('.stream-container');
                const bounds = el.getBoundingClientRect();
                const aspect = 9.0 / 16.0;

                const maxHeight = window.innerHeight - bounds.top - 36; // Maximum allowed height

                // Calculate desired height based on aspect ratio
                const aspectHeight = bounds.width * aspect;

                // Set height based on constraints
                el.style.height = Math.min(maxHeight, aspectHeight) + 'px';
            }


            function addMessage(chatMsg) {
                let username = chatMsg.src;
                let message = chatMsg.text;

                if (chatMsg.role === 'owner') username = watchingStreamAddress;
                if (addressbook[username]) username = addressbook[username].name;
                else if (username.length === 64) username = username.substring(0, 6);
                if (chatMsg.role === 'owner') username = `🎥 ${username}`;

                const color = getUserColor(username);

                const deleteButton = myRole === 'owner'
                    ? `<a class="msg-delete-btn">...</a>` : '';

                const msgElement = document.createElement('div');
                msgElement.classList.add('message');
                msgElement.dataset.messageId = chatMsg.id;
                msgElement.innerHTML = DOMPurify.sanitize(`
        <span>
            <span class="username" style="color:${color}">${username}</span>:
            <span class="chat-text"></span>
            ${deleteButton}
        </span>
    `);

                const chatText = msgElement.querySelector('.chat-text');

                // --- STEP 1: Escape user input to safe HTML text ---
                const escaped = document.createTextNode(message);
                chatText.appendChild(escaped);

                // --- STEP 2: Apply donation highlighting (trusted markup) ---
                // We now modify the DOM safely rather than raw HTML string replace
                const donationRegex = /donate(\d+)/gi;
                let html = chatText.innerHTML;
                html = html.replace(donationRegex, (m, amount) => {
                    amount = parseInt(amount);
                    if (!amount) return m;
                    return `
            <span style="color:#ffd05b;padding:2px;background-color:#ffffff0f;border-radius:5px;">
              ${amount} NKN
            </span>`;
                });

                // sanitize again after injecting trusted markup
                chatText.innerHTML = DOMPurify.sanitize(html, {
                    ALLOWED_TAGS: ['span', 'svg', 'path'], // only allow your donation markup
                    ALLOWED_ATTR: ['style', 'xmlns', 'width', 'height', 'viewBox',
                        'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']
                });

                messagesBox.appendChild(msgElement);
                messagesBox.scrollTop = Number.MAX_SAFE_INTEGER;
            }

            // Handle chat input submission (replace with your logic to send message)
            chatInput.addEventListener('keydown', (event) => {
                if (event.code === 'Enter' || event.code === 'NumpadEnter') { // Enter key pressed
                    event.preventDefault()
                    const message = chatInput.textContent.trim();
                    sendMessage(message);
                }
            });

            chatInput.addEventListener('keyup', (event) => {
                if (event.code === 'Enter' || event.code === 'NumpadEnter') { // Enter key pressed
                    event.preventDefault()
                    console.log(chatInput.textContent);
                }
            });

            collapseBtn.addEventListener('click', () => {
                isCollapsed = !isCollapsed;
                chatbox.style.width = isCollapsed ? '0px' : '300px';
                chatbox.style.padding = isCollapsed ? '0px' : '10px';
                collapseBtn.classList.toggle('collapsed');
                collapseBtn.style.right = isCollapsed ? '0px' : '300px';
                contentContainer.style.width = isCollapsed ? '100%' : 'calc(100% - 320px)';
                sizeVideo();
            });

            function collapseChat() {
                isCollapsed = true;
                chatbox.style.width = isCollapsed ? '0px' : '300px';
                chatbox.style.padding = isCollapsed ? '0px' : '10px';
                collapseBtn.classList.add('collapsed');
                collapseBtn.style.right = isCollapsed ? '0px' : '300px';
                contentContainer.style.width = isCollapsed ? '100%' : 'calc(100% - 320px)';
                sizeVideo();
            }

            function unCollapseChat() {
                isCollapsed = false;
                chatbox.style.width = isCollapsed ? '0px' : '300px';
                chatbox.style.padding = isCollapsed ? '0px' : '10px';
                collapseBtn.classList.remove('collapsed');
                collapseBtn.style.right = isCollapsed ? '0px' : '300px';
                contentContainer.style.width = isCollapsed ? '100%' : 'calc(100% - 320px)';
                sizeVideo();
            }

            chatPopoutBtn.addEventListener('click', () => {
                chatPopoutBtn.classList.toggle('popout');
                unCollapseChat();

                if (chatPopoutWindow == null) {
                    contentContainer.style.width = "100%";
                    collapseBtn.style.display = "none";
                    isCollapsed = true;

                    chatPopoutWindow = window.open("", "", "width=320,height=640, menubar=0, titlebar=0, status=0, toolbar=0");
                    document.head.querySelectorAll('link, style').forEach(htmlElement => {
                        chatPopoutWindow.document.head.appendChild(htmlElement.cloneNode(true));
                    });
                    chatPopoutWindow.document.body.appendChild(chatbox)
                    chatPopoutWindow.onresize = () => {
                        chatPopoutWindow.resizeTo(336, chatPopoutWindow.outerHeight)
                    }

                    //put chat back from whence it came!
                    chatPopoutWindow.onbeforeunload = () => {
                        //place below this element
                        const el = document.querySelector('.stream-container');
                        el.parentNode.insertBefore(chatbox, el.nextSibling)
                    }

                    //put chat back from whence it came!
                    chatPopoutWindow.onbeforeunload = () => {
                        //place below this element
                        const el = document.querySelector('.stream-container');
                        el.parentNode.insertBefore(chatbox, el.nextSibling)
                        chatPopoutBtn.classList.toggle('popout');
                        chatPopoutWindow = null;
                        collapseBtn.style.display = "block";
                        unCollapseChat();

                    }
                } else {
                    //place below this element
                    const el = document.querySelector('.stream-container');
                    el.parentNode.insertBefore(chatbox, el.nextSibling)
                    chatPopoutWindow.onbeforeunload = () => { };
                    chatPopoutWindow.close();
                    chatPopoutWindow = null;
                    collapseBtn.style.display = "block";
                    unCollapseChat();
                }

                sizeVideo();
            });

            function getUserColor(userId) {
                const colors = [
                    "#AACCFF",  // Light Blue
                    "#CDFF00",  // Lime Green
                    "#FFFF00",  // Lemon Yellow
                    "#FF00FF",  // Magenta
                    "#00FFFF",  // Cyan
                    "#FF7F00",  // Orange
                    "#FFC0CB",  // Light Pink
                    "#E6E6FA",  // Lavender
                    "#40E0D0",  // Turquoise
                    "#FFFFFF"   // White
                ];
                return colors[parseInt(userId.substring(0, 4), 16) % 10];
            }

            const chatMessageBinaryPrefix = new Uint8Array([123, 34, 105, 100, 34, 58]);
            function isChatMessage(buffer) {
                if (buffer.length < chatMessageBinaryPrefix.length) return false;
                for (let i = 0; i < chatMessageBinaryPrefix.length; i++) {
                    if (buffer[i] !== chatMessageBinaryPrefix[i]) return false;
                }
                return true;
            }

            function uint8ArrayToJsonString(buffer) {
                const textDecoder = new TextDecoder("utf-8");
                const jsonString = textDecoder.decode(buffer);
                try {
                    return JSON.parse(jsonString);
                } catch (error) {
                    // Handle potential parsing errors
                    console.error("Error parsing JSON string:", error);
                    return null;
                }
            }

            async function getStreamers() {
                const result = await nkn.Wallet.getSubscribers('novon', { txPool: true, meta: true });
                const streamers = { ...result.subscribers, ...result.subscribersInTxPool };

                //streamPreviewContainer.innerHTML = '';

                Object.entries(streamers).forEach(([key, value]) => {
                    createStreamPreviewElement(key, value);
                });
            }

            function createStreamPreviewElement(address, title) {

                var displayAddr = address
                if (addressbook[address] != null) {
                    displayAddr = addressbook[address].name;
                }

                const htmlString = DOMPurify.sanitize(
                    `<div class="stream-preview">
              <a><img id="thumbnail" class="stream-preview-image"></a>
              <h6 style="margin-bottom: 0.5rem;">${title}</h6>
              <span class="address">
                ${displayAddr}
              </span>
              <div style="position: relative; bottom: 71px; left: 1px; background: #00000088; width: fit-content; border-radius: 5px; height: 23px; padding-right: 3px;">
                <svg style="scale: 0.75;" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#dcdcdc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-eye">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg><span id="${address}-viewcount" style="font-size: 14; position: relative; top: -7px">-</span>
              </div>
            </div>`);



                // Parse the HTML string (optional, if security is a concern)
                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlString, "text/html");
                const streamPreview = doc.body.firstChild; // Get the parsed div element

                //set onclicker
                streamPreview.children[0].onclick = () => {
                    watchStream(address);
                };

                // Request channel info
                client.send(address, 'thumbnail').then(async (reply) => {
                    // Assuming you have the base64 string for the JPEG image in a variable called base64String

                    // Convert to a Uint8Array
                    const bytes = new Uint8Array(Object.values(reply));

                    // Convert binary bytes → base64
                    let binary = '';
                    bytes.forEach(b => binary += String.fromCharCode(b));
                    const base64 = btoa(binary);
                    streamPreview.children[0].children[0].src = `data:image/jpeg;base64,${base64}`; // Set the base64 data URI

                    if (streamPreviewContainer.contains(streamPreviews[address])) {
                        streamPreviewContainer.replaceChild(streamPreview, streamPreviews[address]);
                    } else {
                        streamPreviewContainer.appendChild(streamPreview);
                    }
                    streamPreviews[address] = streamPreview;
                }).catch((err) => {
                    if (streamPreviews[address] != null) {
                        streamPreviewContainer.removeChild(streamPreviews[address])
                        delete streamPreviews[address];
                    }
                });

                client.send(address, 'viewcount').then((reply) => {
                    streamViewers[address] = reply;
                    streamPreview.children[3].children[1].innerHTML = reply;
                }).catch((err) => {
                    if (streamPreview[address] != null) {
                        streamPreviewContainer.removeChild(streamPreviews[address])
                        delete streamPreviews[address];
                    }
                    document.getElementById('viewCount').innerHTML = 'offline';
                });

            }

            function watchStream(address) {

                //If username is registerd use the username
                if (addressbook[address] != null) {
                    const username = addressbook[address].name;
                    history.pushState({}, "", username)
                } else {
                    history.pushState({}, "", address)
                }
                document.getElementById('previewContainer').style.display = 'none';

                clearChat();

                videojs.players.streamPlayer.posterImage.hide();
                videojs.players.streamPlayer.bigPlayButton.hide()
                videojs.players.streamPlayer.reset()
                videojs.players.streamPlayer.bigPlayButton.hide()
                videojs.players.streamPlayer.loadingSpinner.show()

                //tell the host we are gone
                if (watchingStreamAddress != '' && watchingStreamAddress != address) {
                    client.send(watchingStreamAddress, 'disconnect', { noReply: true });
                }

                if (streamViewers[address] != null) {
                    document.getElementById('viewCount').innerHTML = streamViewers[address];
                }

                firstChunk = true;
                watchingStreamAddress = address;

                client.send(address, 'ping', { noReply: true });

                client.send(address, 'channelinfo', { responseTimeout: 10000 }).then((info) => {
                    var obj = JSON.parse(info);

                    //Set my role
                    myRole = obj.role;

                    //Set quality levels if available.
                    let options = "";
                    let qLevel = 0;
                    obj.qualityLevels.forEach((q) => {
                        options += `<option ${qLevel == 1 ? 'selected="selected"' : ''} value="${qLevel}">${q.Resolution}p${q.Framerate} ${qLevel == 0 ? '(source)' : ''}</option>`;
                        qLevel++;
                    });
                    qualityLevelsElement.children[0].innerHTML = options;

                    //Parse panels
                    var panelsArray = JSON.parse(obj.panels);
                    const panelsContent = document.getElementById('panelContainer');

                    panelsArray.forEach(panel => {
                        const panelContent = DOMPurify.sanitize(marked.parse(panel));

                        const parser = new DOMParser();
                        const doc = parser.parseFromString(`<div class="panel">${panelContent}</div>`, "text/html");
                        const panelElement = doc.body.firstChild; // Get the parsed div element
                        panelsContent.appendChild(panelElement);
                    });

                    //Set the adaptive quality object
                    //adaptiveQuality = new AdaptiveQuality(document.querySelector('video'), obj.qualityLevels)
                });
            }

            function clearChat() {
                const childElements = messagesBox.children;
                for (let i = childElements.length - 1; i >= 0; i--) {
                    const child = childElements[i];
                    if (child.classList.contains('message')) {
                        messagesBox.removeChild(child);
                    }
                }
            }

            chatDonateButton.onclick = () => {
                if (chatDonatePopup.classList.contains('show')) {
                    chatDonatePopup.classList.remove('show');
                } else {
                    openDonatePopup();
                }
            }

            /*document.getElementById('donateSend1').onclick = () => {
                chatInput.textContent += " donate1 ";
            }*/

            async function sendMessage(text) {
                if (text) {

                    chatProgressLine.style.display = 'block';
                    chatInput.setAttribute('contenteditable', false);

                    let hash = null;

                    if (messageDonationTotal > 0) {

                        //get the donationid
                        const donationId = await client.send(watchingStreamAddress, "donationid", { responseTimeout: 5000 });
                        const walletAddress = nkn.Wallet.publicKeyToAddress(watchingStreamAddress);

                        try {
                            hash = await client.transferTo(walletAddress, messageDonationTotal, donationId);
                            console.log(hash);
                            chatDonatePopup.classList.remove('show');
                        } catch (err) {
                            chatInput.setAttribute('contenteditable', true);
                            chatInput.focus();
                            chatProgressLine.style.display = 'none';

                            let errMsg = '';
                            if (err.code == 45021) {
                                errMsg = 'insufficient funds';
                            } else {
                                errMsg = err.message.split(', ')[1];
                            }

                            chatErrorMessage.textContent = errMsg;
                            chatErrorMessage.style.display = 'block';

                            return;
                        }
                    }

                    let chatMsg = {
                        type: 'chat-message',
                        content: { text: text }
                    }
                    if (hash != null) {
                        chatMsg.content.hash = hash.data;
                    }

                    const reply = await client.send(watchingStreamAddress, JSON.stringify(chatMsg), { noReply: hash == null, responseTimeout: 60000 });
                    if (reply) {
                        const replyString = String.fromCharCode(...Object.values(reply));
                        if (replyString != "success") {
                            var username = chatMsg.src;
                            var message = chatMsg.text;
                            var errorMsg = {
                                src: "ERROR",
                                text: replyString.replace('error: ', '')
                            }
                            addMessage(errorMsg)
                        }
                    }

                    chatInput.textContent = ''; // Clear input field after sending message
                    chatInput.setAttribute('contenteditable', true);
                    chatInput.focus();
                    chatProgressLine.style.display = 'none';
                }
            }

            const config = {
                characterData: true, attributes: false, childList: false, subtree: true
            };
            const observer = new MutationObserver(processChatInput);
            observer.observe(chatInput, config);


            function processChatInput(event) {
                //clear errors
                chatErrorMessage.textContent = '';
                chatErrorMessage.style.display = 'none';

                if (chatInput.textContent.length > maxChars) {
                    chatInput.textContent = chatInput.textContent.substring(0, maxChars);
                    setEndOfContenteditable(chatInput)
                }

                const text = chatInput.textContent;
                const donateMatches = [...text.matchAll(donationRegex)];

                messageDonationTotal = 0;
                donateMatches.forEach(match => {
                    const amount = parseInt(match[0].replace('donate', ''));
                    messageDonationTotal += amount;
                });

                if (messageDonationTotal > 0) {
                    openDonatePopup();
                } else {
                    chatDonateAmount.textContent = 0;
                }
            }

            function setEndOfContenteditable(contentEditableElement) {
                var range, selection;
                if (document.createRange)//Firefox, Chrome, Opera, Safari, IE 9+
                {
                    range = document.createRange();//Create a range (a range is a like the selection but invisible)
                    range.selectNodeContents(contentEditableElement);//Select the entire contents of the element with the range
                    range.collapse(false);//collapse the range to the end point. false means collapse to end rather than the start
                    selection = window.getSelection();//get the selection object (allows you to change selection)
                    selection.removeAllRanges();//remove any selections already made
                    selection.addRange(range);//make the range you have just created the visible selection
                }
                else if (document.selection)//IE 8 and lower
                {
                    range = document.body.createTextRange();//Create a range (a range is a like the selection but invisible)
                    range.moveToElementText(contentEditableElement);//Select the entire contents of the element with the range
                    range.collapse(false);//collapse the range to the end point. false means collapse to end rather than the start
                    range.select();//Select the range (make it the visible selection
                }
            }

            async function openDonatePopup() {
                chatDonateAmount.textContent = messageDonationTotal;
                if (walletBalance - txFee < messageDonationTotal) {
                    chatDonateAmount.style.boxShadow = 'inset 0 0 3px #f00';
                } else {
                    chatDonateAmount.style.boxShadow = '';
                }

                if (chatDonatePopup.classList.contains('show')) {
                    return;
                }

                chatDonatePopup.classList.add('show');
                walletBalance = await nkn.Wallet.getBalance(novio.address);
                chatWalletBalance.textContent = walletBalance;

                if (walletBalance - txFee < messageDonationTotal) {
                    chatDonateAmount.style.boxShadow = 'inset 0 0 3px #f00';
                } else {
                    chatDonateAmount.style.boxShadow = '';
                }
            }

            async function getAddressbook() {
                let pageIndex = 1;

                while (true) {
                    const response = await fetch(`https://openapi.nkn.org/api/v1/address-book/?page=${pageIndex}&per_page=250`);
                    const jsonData = await response.json();
                    const addresses = jsonData.data.filter((o) => o.public_key.length > 0)
                    pageIndex++;

                    addresses.forEach(address => {
                        if (addressbook[address.public_key] != null) {
                            const newAddrDate = new Date(address.expires_at).getTime()
                            const oldAddrDate = new Date(addressbook[address.public_key].expires_at).getTime()

                            if (newAddrDate > oldAddrDate) {
                                addressbook[address.public_key] = address;
                            }
                        } else {
                            addressbook[address.public_key] = address;
                        }
                    });

                    if (jsonData.data.length < 250) {
                        break;
                    }
                }
            }

            async function sendDeleteMessageRequest(messageId) {
                let deleteMsg = {
                    type: 'delete-chat-message',
                    content: { msgId: messageId }
                }
                client.send(watchingStreamAddress, JSON.stringify(deleteMsg), { noReply: true });
            }

            async function deleteMessage(messageId) {
                var message = chatbox.querySelector(`[data-message-id="${messageId}"]`);
                message.querySelector(".chat-text")
                    .innerHTML = `<em style="color: #aaaaaa">message removed</em>`

                //remove button
                message.children[0].removeChild(message.querySelector('a'));
            }



            function updateDebugView() {
                const container = document.getElementById("debugView");
                container.innerHTML = "";

                const ids = Object.keys(segments).sort((a, b) => a - b);
                for (const id of ids) {
                    const seg = segments[id];
                    const row = document.createElement("div");
                    row.className = "segment-row";

                    const label = document.createElement("div");
                    label.className = "segment-label";
                    label.textContent = id === nextSegmentId
                        ? `▶ Seg ${id}`
                        : `Seg ${id}`;

                    const bar = document.createElement("div");
                    bar.className = "chunk-bar";
                    for (let i = 0; i < seg.totalChunks; i++) {
                        const c = document.createElement("div");
                        c.className = "chunk";
                        if (seg.received[i]) c.classList.add("received");
                        if (id == nextSegmentId && !seg.received[i]) c.classList.add("expected");
                        bar.appendChild(c);
                    }

                    row.appendChild(label);
                    row.appendChild(bar);
                    container.appendChild(row);
                }
            }
        }
    }
    // Only expose what's necessary (e.g., initialization function)
    exports.initApp = function (startupWallet, novioSignOn) {
        const app = new StreamApp();
        app.startApp(startupWallet, novioSignOn);
    };

    exports.startWithNovio = async function (client) {
        const app = new StreamApp();
        app.startApp(null, client);
    }

    class NknClient {
        client;
        wallet;

        constructor(wallet) {
            this.wallet = wallet;
        }

        async Setup() {
            debugger;
            let secureEnvironment = window.location.protocol == "https:";

            this.client = new nkn.MultiClient({
                numSubClients: numSubClients,
                originalClient: false,
                seed: this.wallet.getSeed(),
                tls: secureEnvironment ? true : false,
                webrtc: secureEnvironment ? true : false,
            });

            let connectedNodes = 0;
            let failedNodes = 0;

            for (const [key, value] of Object.entries(this.client.clients)) {
                value.eventListeners.connect.push(() => {
                    connectedNodes++;
                    let baseText = `${connectedNodes}/${numSubClients} nodes`;
                    let warningText = '\ntrying to find more nodes...'
                    document.getElementById('subclients-connected').textContent = baseText + (connectedNodes < numSubClients ? warningText : '');
                });

                value.eventListeners.connectFailed.push(() => {
                    console.warn(key, 'failed');
                    failedNodes++;
                    let baseText = `${connectedNodes}/${numSubClients} nodes`;
                    let warningText = '\ntrying to find more nodes...'
                    document.getElementById('subclients-connected').textContent = baseText + (connectedNodes < numSubClients ? warningText : '');
                });
            }

            while (connectedNodes + failedNodes < numSubClients - 1 && connectedNodes < numSubClients - 1) {
                await new Promise(r => setTimeout(r, 50));
            }

            if (connectedNodes > 0) {
                return this.client;
            } else {
                alert("No nodes found to connect, if the issue persists try joining as guest and please report. \n\n(for firefox users: Settings-> Privacy & Security -> Disabled check for block dangerous and deceptive content. Sadly Firefox has marked NKN nodes as dangerous...)")
            }
        }
    }
})(window.streamApp = window.streamApp || {}); // Namespace for optional isolation
(function (exports) {
    class StreamApp {
        async startApp(startupWallet) {
            document.getElementById("login-popup").style.display = "none";
            document.getElementById("connection-indicator").style.display = 'block';

            const chatbox = document.getElementById('chatbox');
            const messagesBox = document.getElementById('messagesBox');
            const chatInput = document.getElementById('chat-input');
            const collapseBtn = document.getElementById('collapse-btn');
            const contentContainer = document.querySelector('.content-container');
            const streamPreviewContainer = document.querySelector('.stream-preview-container');

            const appendSemaphore = new Semaphore(1);

            var client = null;
            const numSubClients = 3;
            var firstChunk = true;
            var watchingStreamAddress = '';

            var video = null;
            var sourceBuffer = null;
            var transmuxer = null;


            const segments = {};
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

            var wallet = null;
            if (startupWallet != null) {
                wallet = startupWallet;
                isGuest = false;
            } else {
                wallet = new nkn.Wallet({});
            }

            var myRole = '';

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

            client = await setupClient(numSubClients);

            document.getElementById('connection-indicator').style.display = 'none';
            document.getElementById('blackoutPanel').style.display = 'none';

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
                }
            }, 10000);

            getStreamers();
            setInterval(() => {
                getStreamers()
            }, 30000);

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

                if (watchingStreamAddress == '') {
                    return;
                }
                const watchingStreamAddressFromUsername = addressbook[src].public_key;
                if (src != watchingStreamAddress && src != watchingStreamAddressFromUsername) {
                    return;
                }
                if (payload instanceof Uint8Array) {

                    if (isChatMessage(payload)) {
                        const chatMsg = uint8ArrayToJsonString(payload)
                        //if (chatMsg.src != client.addr) {
                        addMessage(chatMsg)
                        //}
                        return;
                    }

                    handleChunk(payload, (id, data) => {
                        //console.log("segment complete id:", id, "length:", data.length)
                        if (firstChunk) {
                            appendFirstSegment(data);
                            firstChunk = false;

                            //Allow chatting
                            chatInput.setAttribute('contenteditable', true);
                            document.querySelector('.donate-button').style.display = 'block';
                            chatInput.textContent = '';

                        } else if (id == qualityChangedSegmentId) {
                            appendFirstSegment(data);
                        } else {
                            appendNextSegment(data);
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

                var arrayBuffer = data.buffer.slice(data.byteOffset, data.byteLength + data.byteOffset);

                const segmentId = new DataView(arrayBuffer, 0, 4).getUint32(0, true);
                const chunkId = new DataView(arrayBuffer, 4, 4).getUint32(0, true);
                const totalChunks = new DataView(arrayBuffer, 8, 4).getUint32(0, true);

                if (!segments[segmentId]) {
                    segments[segmentId] = {
                        data: new Uint8Array(totalChunks * CHUNK_SIZE),
                        chunksReceived: 0,
                        totalChunks,
                        bytesReceived: 0
                    };
                }

                const segment = segments[segmentId];
                let dataSlice = data.slice(12);
                segment.data.set(dataSlice, chunkId * CHUNK_SIZE);
                segment.chunksReceived++;
                segment.bytesReceived += dataSlice.length;

                if (segment.chunksReceived === segment.totalChunks) {
                    onSegmentComplete(segmentId, segment.data.slice(0, segment.bytesReceived));
                    delete segments[segmentId];
                }
            };

            async function appendFirstSegment(chunk) {
                await appendSemaphore.acquire()
                try {
                    let mediaSource = new MediaSource();
                    transmuxer = new muxjs.mp4.Transmuxer();

                    video = document.querySelector('video');
                    video.src = URL.createObjectURL(mediaSource);
                    videojs('streamPlayer').controlBar.progressControl.hide();


                    videojs('streamPlayer').on(['waiting', 'pause'], function () {
                        isPlaying = false;
                    });

                    videojs('streamPlayer').on('playing', function () {
                        isPlaying = true;
                        segmentsBehind = 0;
                    });

                    const waitForOpen = new Promise((resolve) => {
                        mediaSource.addEventListener("sourceopen", resolve);
                    })

                    await waitForOpen;

                    URL.revokeObjectURL(video.src);

                    sourceBuffer = mediaSource.addSourceBuffer(mime);
                    sourceBuffer.addEventListener('updateend', async () => {
                        if (!isPlaying) {
                            if (!isPlaying && segmentsBehind > 3) {
                                videojs.players.streamPlayer.liveTracker.seekToLiveEdge()
                                segmentsBehind = 0;
                            }
                            segmentsBehind++;
                        }

                        //Clean up sourcebuffer when it grows beyond 20s to 10s
                        for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                            const bufferLength = sourceBuffer.buffered.end(i) - sourceBuffer.buffered.start(i);
                            if (bufferLength > 20) {
                                //console.log(`clearing out ${sourceBuffer.buffered.end(i) - 10 - sourceBuffer.buffered.start(i)} seconds from sb`)
                                sourceBuffer.remove(sourceBuffer.buffered.start(i), sourceBuffer.buffered.end(i) - 10)
                                while (sourceBuffer.updating) {
                                    await new Promise(r => setTimeout(r, 1));
                                }
                            }
                        }
                    });
                    transmuxer.on('data', async (segment) => {
                        let data = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
                        data.set(segment.initSegment, 0);
                        data.set(segment.data, segment.initSegment.byteLength);
                        console.log(muxjs.mp4.tools.inspect(data));

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
                    try {
                        while (sourceBuffer.updating) {
                            await new Promise(r => setTimeout(r, 1));
                        }
                        sourceBuffer.appendBuffer(new Uint8Array(segment.data));
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

            let isCollapsed = false;

            function addMessage(chatMsg) {
                var username = chatMsg.src;
                var message = chatMsg.text;

                //impersonate owner
                if (chatMsg.role == 'owner') {
                    username = watchingStreamAddress
                }

                var color = getUserColor(username);
                if (username == 'ERROR') {
                    color = "#FF0000"
                }

                //If username is registerd use the username
                if (addressbook[username] != null) {
                    username = addressbook[username].name;
                } else if (username.length == 64) { //otherwise take the shortened hex address
                    username = username.substring(0, 6)
                }

                if (chatMsg.role == 'owner') {
                    username = `🎥 ` + username;
                }

                const donateMatches = [...message.matchAll(donationRegex)];
                donateMatches.forEach(match => {
                    const amount = parseInt(match[0].replace('donate', ''));
                    if (amount != 0) {
                        message = message.replace(match[0], `
            <span style="color: #0fa0ce; padding: 2px 2px 2px 2px; background-color: #ffffff0f; border-radius: 5px;">
              <svg style="scale: 0.7;position: relative;top: 7; margin-top: -10px;" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
              </svg>${amount} NKN
            </span>`)
                    }

                });

                var deleteButton = '<a class="msg-delete-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-trash-2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></a>';
                if (myRole != 'owner') {
                    deleteButton = '';
                }

                const msgElement = document.createElement('div');
                msgElement.classList.add('message');
                msgElement.setAttribute('data-message-id', chatMsg.id);
                msgElement.innerHTML = DOMPurify.sanitize(`
            <span>
                <span class="username" style="color: ${color}">${username}
                </span>: 
                <span class="chat-text"></span>
                ${deleteButton}
            </span>`);

                if (myRole == 'owner') {
                    msgElement.querySelector('.msg-delete-btn').onclick = () => {
                        sendDeleteMessageRequest(chatMsg.id);
                    };
                }

                //set the message, sanitized.
                msgElement.querySelector('.chat-text').textContent = DOMPurify.sanitize(message)

                messagesBox.appendChild(msgElement);

                // Scroll to bottom after adding new message
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

            async function setupClient(targetClients) {
                let client = new nkn.MultiClient({
                    numSubClients: targetClients,
                    originalClient: false,
                    seed: wallet.getSeed(),
                    //tls: true,
                });

                let connectedNodes = 0;
                let failedNodes = 0;

                for (const [key, value] of Object.entries(client.clients)) {
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

                while (connectedNodes + failedNodes < targetClients && connectedNodes < numSubClients) {
                    await new Promise(r => setTimeout(r, 50));
                }

                if (connectedNodes > 0) {
                    return client;
                } else {
                    alert("No nodes found to connect, if the issue persists try joining as guest and please report. \n\n(for firefox users: Settings-> Privacy & Security -> Disabled check for block dangerous and deceptive content. Sadly Firefox has marked NKN nodes as dangerous...)")
                }
            }

            async function getStreamers() {
                const result = await client.getSubscribers('novon', { txPool: true, meta: true });
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
                    const base64 = await bufferToBase64(reply);
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

            document.querySelector('.donate-button').onclick = () => {
                if (document.querySelector('.donate-popup').classList.contains('show')) {
                    document.querySelector('.donate-popup').classList.remove('show');
                } else {
                    openDonatePopup();
                }
            }

            document.getElementById('donateSend1').onclick = () => {
                chatInput.textContent += " donate1 ";
            }

            async function sendMessage(text) {
                if (text) {

                    document.querySelector('.progress-line').style.display = 'block';
                    chatInput.setAttribute('contenteditable', false);

                    let hash = null;

                    if (messageDonationTotal > 0) {

                        //get the donationid
                        const donationId = await client.send(watchingStreamAddress, "donationid", { responseTimeout: 5000 });
                        const walletAddress = nkn.Wallet.publicKeyToAddress(watchingStreamAddress);

                        try {
                            hash = await wallet.transferTo(walletAddress, messageDonationTotal, { fee: 0.1, attrs: donationId });
                            console.log(hash);
                            document.querySelector('.donate-popup').classList.remove('show');
                        } catch (err) {
                            chatInput.setAttribute('contenteditable', true);
                            chatInput.focus();
                            document.querySelector('.progress-line').style.display = 'none';

                            let errMsg = '';
                            if (err.code == 45021) {
                                errMsg = 'insufficient funds';
                            } else {
                                errMsg = err.message.split(', ')[1];
                            }

                            document.querySelector('.error-message').textContent = errMsg;
                            document.querySelector('.error-message').style.display = 'block';

                            return;
                        }
                    }

                    let chatMsg = {
                        type: 'chat-message',
                        content: { text: text }
                    }
                    if (hash != null) {
                        chatMsg.content.hash = hash;
                    }

                    const reply = await client.send(watchingStreamAddress, JSON.stringify(chatMsg), { noReply: hash == null, responseTimeout: 60000 });
                    if (reply) {
                        const replyString = new TextDecoder().decode(reply);
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
                    document.querySelector('.progress-line').style.display = 'none';
                }
            }

            const config = {
                characterData: true, attributes: false, childList: false, subtree: true
            };
            const observer = new MutationObserver(processChatInput);
            observer.observe(chatInput, config);


            function processChatInput(event) {
                //clear errors
                document.querySelector('.error-message').textContent = '';
                document.querySelector('.error-message').style.display = 'none';

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
                    document.querySelector('.donate-amount').textContent = 0;
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
                document.querySelector('.donate-amount').textContent = messageDonationTotal;
                if (walletBalance - txFee < messageDonationTotal) {
                    document.querySelector('.donate-amount').style.boxShadow = 'inset 0 0 3px #f00';
                } else {
                    document.querySelector('.donate-amount').style.boxShadow = '';
                }

                if (document.querySelector('.donate-popup').classList.contains('show')) {
                    return;
                }

                document.querySelector('.donate-popup').classList.add('show');
                walletBalance = await wallet.getBalance();
                document.querySelector('.wallet-balance').textContent = walletBalance;

                if (walletBalance - txFee < messageDonationTotal) {
                    document.querySelector('.donate-amount').style.boxShadow = 'inset 0 0 3px #f00';
                } else {
                    document.querySelector('.donate-amount').style.boxShadow = '';
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
                var message = document.querySelector(`[data-message-id="${messageId}"]`);
                message.querySelector(".chat-text")
                    .innerHTML = `<em style="color: #aaaaaa">message removed</em>`

                //remove button
                message.children[0].removeChild(message.querySelector('a'));
            }

            document.getElementById("depositButton").onclick = () => {
                if (!isGuest) {
                    document.getElementById("showWalletAddress").textContent = wallet.address;
                    document.getElementById("feeWarningText").textContent = "Deposit NKN to this address:"
                    document.getElementById("showWalletAddress").style.display = 'inline-block';
                } else {
                    document.getElementById("feeWarningText").textContent = "Please join novon - any funds send to a guest account will be lost."
                }
            }
        }
    }
    // Only expose what's necessary (e.g., initialization function)
    exports.initApp = function (startupWallet) {
        const app = new StreamApp();
        app.startApp(startupWallet);
    };
})(window.streamApp = window.streamApp || {}); // Namespace for optional isolation
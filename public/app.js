const socket = io();

/* =====================================================
   THEME (dark mode) + WALLPAPER
   ===================================================== */

const THEME_KEY = "chatapp_theme";
const WALLPAPER_KEY = "chatapp_wallpaper";

const WALLPAPERS = [
    "none",
    "radial-gradient(circle, rgba(127,127,127,.12) 1px, transparent 1px)",
    "linear-gradient(135deg, rgba(127,127,127,.08) 25%, transparent 25%, transparent 50%, rgba(127,127,127,.08) 50%, rgba(127,127,127,.08) 75%, transparent 75%, transparent)",
    "linear-gradient(rgba(127,127,127,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(127,127,127,.08) 1px, transparent 1px)",
    "linear-gradient(160deg, rgba(37,99,235,.06), rgba(34,197,94,.06))"
];

function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    const btn = document.getElementById("themeToggleBtn");
    if (btn) btn.innerHTML = theme === "dark" ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    refreshIcons();
}

function applyWallpaper(index) {
    const box = document.getElementById("messages");
    if (!box) return;
    const val = WALLPAPERS[index] || WALLPAPERS[0];
    box.style.backgroundImage = val === "none" ? "none" : val;
    box.style.backgroundSize = index === 3 ? "24px 24px" : "340px";
    localStorage.setItem(WALLPAPER_KEY, String(index));
}

function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
}

(function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || "light";
    applyTheme(saved);
    const savedWallpaper = parseInt(localStorage.getItem(WALLPAPER_KEY) || "0", 10);
    applyWallpaper(savedWallpaper);
})();

document.getElementById("themeToggleBtn").onclick = function () {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "dark" ? "light" : "dark");
    if (username) saveThemePreferences();
};

let wallpaperIndex = parseInt(localStorage.getItem(WALLPAPER_KEY) || "0", 10);

document.getElementById("wallpaperBtn").onclick = function () {
    wallpaperIndex = (wallpaperIndex + 1) % WALLPAPERS.length;
    applyWallpaper(wallpaperIndex);
    if (username) saveThemePreferences();
    showToast("Wallpaper changed");
};

/* =====================================================
   TOASTS
   ===================================================== */

function showToast(message) {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2100);
}

/* =====================================================
   EMOJI PICKER (unchanged behavior)
   ===================================================== */

const emojiBtn = document.getElementById("emojiBtn");
const emojiBox = document.getElementById("emojiBox");

const picker = document.createElement("emoji-picker");

emojiBox.appendChild(picker);

emojiBtn.onclick = function () {

    if (emojiBox.style.display === "none") {

        emojiBox.style.display = "block";

    } else {

        emojiBox.style.display = "none";

    }

};

picker.addEventListener("emoji-click", function (event) {

    const input = document.getElementById("msg");

    input.value += event.detail.unicode;

    input.focus();

    emojiBox.style.display = "none";

});

/* =====================================================
   STATE
   ===================================================== */

let username = "";
let selectedUser = "";
let selectedGroup = "";
let chatMode = "";          // "user" | "group" | ""

let editingMessageId = null;
let replyMessage = null;

let allContacts = [];       // last data received from "contactsList"
let allGroups = [];         // last data received from "groupsList"
let forwardTarget = null;   // the message being forwarded
let forwardSelected = new Set();

let currentGroupInfo = null;      // last data received from "groupMembers" for the open group-info modal
let profileTargetUsername = null; // whose profile the profile modal is currently showing

// voice recording
let mediaRecorder;
let audioChunks = [];
let audioBlob = null;
let isRecording = false;
let timer;
let seconds = 0;

fetch("/username")
    .then(res => res.text())
    .then(name => {

        // Extra client-side guard on top of the server-side redirect in
        // app.get("/chat") — if there's no active session, bounce to login
        // immediately instead of showing an empty chat shell.
        if (!name) {
            window.location.href = "/";
            return;
        }

        console.log("Logged User :", name);

        username = name;

        socket.emit("join", username);

        // Kept for backward compatibility with the original global history feature
        socket.emit("loadMessages");

        socket.emit("loadContacts", username);
        socket.emit("loadGroups", username);

        // Sync theme/wallpaper preference from MongoDB, so it follows the
        // user across devices/browsers instead of being purely per-device.
        fetch("/profile/" + encodeURIComponent(username))
            .then(res => res.json())
            .then(data => {
                if (!data.success) return;
                if (data.profile.theme) applyTheme(data.profile.theme);
                if (typeof data.profile.wallpaper === "number") {
                    wallpaperIndex = data.profile.wallpaper;
                    applyWallpaper(wallpaperIndex);
                }
            })
            .catch(() => {});

    });

/* =====================================================
   HELPERS
   ===================================================== */

function escapeHtml(str) {
    if (str === undefined || str === null) return "";
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function initials(name) {
    return (name || "?").trim().charAt(0).toUpperCase();
}

// Renders either an uploaded avatar image or a fallback initials circle —
// used everywhere an avatar shows up (sidebar, chat header, profile, group info).
function avatarHtml(name, avatarPath) {
    if (avatarPath) {
        return `<img src="${escapeHtml(avatarPath)}" class="avatar-img" alt="${escapeHtml(name)}">`;
    }
    return escapeHtml(initials(name));
}

function formatTime(date) {
    if (!date) return "";
    const d = new Date(date);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + m + " " + ampm;
}

function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds || 0));
    const min = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, "0");
    return min + ":" + sec;
}

function formatContactTime(date) {
    if (!date) return "";
    const d = new Date(date);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return formatTime(d);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function lastMessagePreview(msg) {
    if (!msg) return "No messages yet";
    if (msg.deleted) return "This message was deleted";
    if (msg.text) return (msg.forwarded ? "↪ " : "") + msg.text;
    if (msg.image) return "📷 Photo";
    if (msg.voice) return "🎤 Voice message";
    return "";
}

/* =====================================================
   SIDEBAR (contacts + groups, unified WhatsApp-style list)
   ===================================================== */

// Merges contacts and groups into one list sorted by most-recent activity.
function buildChatListItems(filterText) {

    const filter = (filterText || "").toLowerCase().trim();
    const items = [];

    allContacts.forEach(c => items.push({
        type: "user",
        id: c.username,
        name: c.name || c.username,
        avatar: c.avatar,
        online: c.online,
        lastMessage: c.lastMessage,
        unreadCount: c.unreadCount
    }));

    allGroups.forEach(g => items.push({
        type: "group",
        id: g.id,
        name: g.name,
        avatar: g.image,
        online: g.online,
        memberCount: g.memberCount,
        lastMessage: g.lastMessage,
        unreadCount: g.unreadCount
    }));

    return items
        .filter(it => it.name.toLowerCase().includes(filter))
        .sort((a, b) => {
            const at = a.lastMessage ? new Date(a.lastMessage.time).getTime() : 0;
            const bt = b.lastMessage ? new Date(b.lastMessage.time).getTime() : 0;
            return bt - at;
        });

}

function renderContacts(filterText) {

    const list = document.getElementById("contacts");
    list.innerHTML = "";

    const items = buildChatListItems(filterText);

    if (!items.length) {
        list.innerHTML = `<li class="empty-sidebar-hint">No chats or users yet</li>`;
        return;
    }

    items.forEach(it => {

        const isActive = it.type === "user"
            ? (chatMode === "user" && it.id === selectedUser)
            : (chatMode === "group" && it.id === selectedGroup);

        const li = document.createElement("li");
        li.className = "contact-item" + (isActive ? " active" : "");

        const previewPrefix = it.type === "group" && it.lastMessage
            ? `<b>${escapeHtml((it.lastMessage.sender === username ? "You" : it.lastMessage.sender))}:</b> `
            : "";

        li.innerHTML = `
            <div class="contact-avatar">
                ${avatarHtml(it.name, it.avatar)}
                <span class="online-dot ${it.online ? "online" : ""}"></span>
            </div>
            <div class="contact-info">
                <div class="contact-name-row">
                    <span class="contact-name">${it.type === "group" ? "👥 " : ""}${escapeHtml(it.name)}</span>
                    <span class="contact-time">${formatContactTime(it.lastMessage && it.lastMessage.time)}</span>
                </div>
                <div class="contact-preview-row">
                    <span class="contact-preview">${previewPrefix}${escapeHtml(lastMessagePreview(it.lastMessage))}</span>
                    ${it.unreadCount ? `<span class="unread-badge">${it.unreadCount}</span>` : ""}
                </div>
            </div>
        `;

        li.onclick = function () {
            if (it.type === "group") {
                selectGroup(it.id);
            } else {
                selectUser(it.id);
            }
        };

        // Clicking the avatar opens the profile/group-info instead of just opening the chat.
        li.querySelector(".contact-avatar").addEventListener("click", function (e) {
            e.stopPropagation();
            if (it.type === "group") {
                openGroupInfo(it.id);
            } else {
                openProfile(it.id);
            }
        });

        list.appendChild(li);

    });

}

socket.on("contactsList", (contacts) => {

    allContacts = contacts;
    renderContacts(document.getElementById("userSearch").value);

});

socket.on("groupsList", (groups) => {

    allGroups = groups;
    renderContacts(document.getElementById("userSearch").value);

});

document.getElementById("userSearch").addEventListener("input", function () {
    renderContacts(this.value);
});

function selectUser(user) {

    chatMode = "user";
    selectedUser = user;
    selectedGroup = "";

    const contact = allContacts.find(c => c.username === user);

    document.getElementById("chatUser").innerHTML = escapeHtml((contact && contact.name) || user);
    document.getElementById("chatAvatar").innerHTML = avatarHtml(user, contact && contact.avatar);
    document.getElementById("chatHeaderInfo").onclick = () => openProfile(user);
    document.getElementById("groupMembersBtn").style.display = "none";

    closeSearchBar();
    closeSidebarMobile();

    socket.emit("loadPrivateMessages", {
        sender: username,
        receiver: selectedUser
    });

    socket.emit("seenMessages", {
        sender: selectedUser,
        receiver: username
    });

    socket.emit("loadPinned", {
        sender: username,
        receiver: selectedUser
    });

    renderContacts(document.getElementById("userSearch").value);

}

function selectGroup(groupId) {

    chatMode = "group";
    selectedGroup = groupId;
    selectedUser = "";

    const group = allGroups.find(g => g.id === groupId);

    document.getElementById("chatUser").innerHTML = escapeHtml(group ? group.name : "Group");
    document.getElementById("chatAvatar").innerHTML = avatarHtml(group ? group.name : "G", group && group.image);
    document.getElementById("chatHeaderInfo").onclick = () => openGroupInfo(groupId);
    document.getElementById("groupMembersBtn").style.display = "inline-flex";

    closeSearchBar();
    closeSidebarMobile();

    socket.emit("loadGroupMessages", { groupId, username });
    socket.emit("loadPinned", { groupId });

    renderContacts(document.getElementById("userSearch").value);

}

/* =====================================================
   MOBILE SIDEBAR DRAWER
   ===================================================== */

function openSidebarMobile() {
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("sidebarOverlay").classList.add("show");
}

function closeSidebarMobile() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebarOverlay").classList.remove("show");
}

document.getElementById("mobileMenuBtn").onclick = openSidebarMobile;
document.getElementById("sidebarCloseBtn").onclick = closeSidebarMobile;
document.getElementById("sidebarOverlay").onclick = closeSidebarMobile;

/* =====================================================
   SEND MESSAGE
   ===================================================== */

function sendMessage() {

    const hasTarget = chatMode === "group" ? !!selectedGroup : !!selectedUser;

    if (!hasTarget) {
        alert("Select a chat first");
        return;
    }

    const input = document.getElementById("msg");

    const text = input.value.trim();

    if (editingMessageId) {

        socket.emit("editMessage", {

            id: editingMessageId,
            text: text,
            username: username

        });

        editingMessageId = null;

        input.value = "";

        return;

    }

    if (text === "") return;

    if (chatMode === "group") {

        socket.emit("groupMessage", {
            groupId: selectedGroup,
            sender: username,
            text: text,
            reply: replyMessage
        });

    } else {

        socket.emit("privateMessage", {
            sender: username,
            receiver: selectedUser,
            text: text,
            reply: replyMessage
        });

    }

    replyMessage = null;

    document.getElementById("replyPreview").style.display = "none";
    input.value = "";

}

document
    .getElementById("sendBtn")
    .addEventListener("click", sendMessage);

/* =====================================================
   FILE / VOICE (unchanged behavior)
   ===================================================== */

document
    .getElementById("fileBtn")
    .onclick = function () {

        document
            .getElementById("imageInput")
            .click();

    };

const voiceBtn = document.getElementById("voiceBtn");

voiceBtn.onclick = async function () {

    const hasTarget = chatMode === "group" ? !!selectedGroup : !!selectedUser;

    if (!hasTarget) {
        alert("Select a chat first");
        return;
    }

    // Guards against the old bug where clicking the mic twice while already
    // recording silently created a second MediaRecorder and lost the first take.
    if (isRecording) return;

    let stream;

    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        console.error(err);
        showToast("Microphone permission denied");
        return;
    }

    isRecording = true;
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = function (event) {
        audioChunks.push(event.data);
    };

    mediaRecorder.onstop = function () {

        audioBlob = new Blob(audioChunks, { type: "audio/webm" });

        const preview = document.getElementById("previewAudio");
        preview.src = URL.createObjectURL(audioBlob);
        preview.style.display = "block";

        // Release the microphone so the browser's recording indicator turns off.
        stream.getTracks().forEach(t => t.stop());

    };

    mediaRecorder.start();

    voiceBtn.style.display = "none";
    document.getElementById("recordPanel").style.display = "flex";

    seconds = 0;
    document.getElementById("timer").textContent = "00:00";

    timer = setInterval(() => {

        seconds++;

        const min = String(Math.floor(seconds / 60)).padStart(2, "0");
        const sec = String(seconds % 60).padStart(2, "0");

        document.getElementById("timer").textContent = min + ":" + sec;

    }, 1000);

};

function stopRecording() {

    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
    }

    clearInterval(timer);
    isRecording = false;
    voiceBtn.style.display = "inline-flex";

}

document.getElementById("stopBtn").onclick = stopRecording;

function resetRecordingUI() {

    const preview = document.getElementById("previewAudio");
    preview.pause();
    preview.src = "";
    preview.style.display = "none";

    document.getElementById("recordPanel").style.display = "none";
    voiceBtn.style.display = "inline-flex";

    audioBlob = null;
    isRecording = false;

}

document.getElementById("sendVoiceBtn").onclick = async function () {

    if (!audioBlob) {
        showToast("No voice recorded");
        return;
    }

    const recordedSeconds = seconds;

    const formData = new FormData();
    formData.append("voice", audioBlob, "voice.webm");

    try {

        const response = await fetch("/uploadVoice", { method: "POST", body: formData });
        const result = await response.json();

        if (result.success) {

            if (chatMode === "group") {
                socket.emit("groupMessage", {
                    groupId: selectedGroup,
                    sender: username,
                    voice: result.path,
                    duration: recordedSeconds
                });
            } else {
                socket.emit("privateVoice", {
                    sender: username,
                    receiver: selectedUser,
                    voice: result.path,
                    duration: recordedSeconds
                });
            }

        } else {
            showToast("Voice upload failed");
        }

    } catch (err) {
        console.error(err);
        showToast("Voice upload failed");
    }

    resetRecordingUI();

};

document.getElementById("cancelBtn").onclick = resetRecordingUI;

document
    .getElementById("imageInput")
    .addEventListener("change", async function () {

        const file = this.files[0];

        if (!file) return;

        const hasTarget = chatMode === "group" ? !!selectedGroup : !!selectedUser;

        if (!hasTarget) {
            alert("Select a chat first");
            return;
        }

        const formData = new FormData();

        formData.append("image", file);

        try {

            const response = await fetch("/upload", {
                method: "POST",
                body: formData
            });

            const result = await response.json();

            if (result.success) {

                if (chatMode === "group") {
                    socket.emit("groupMessage", {
                        groupId: selectedGroup,
                        sender: username,
                        image: result.path
                    });
                } else {
                    socket.emit("privateImage", {
                        sender: username,
                        receiver: selectedUser,
                        image: result.path
                    });
                }

            } else {
                showToast("Image upload failed");
            }

        } catch (err) {
            console.error(err);
            showToast("Image upload failed");
        }

        this.value = "";

    });

/* =====================================================
   TYPING INDICATOR (unchanged)
   ===================================================== */

let typing = false;
let typingTimer;

document
    .getElementById("msg")
    .addEventListener("input", function (e) {

        if (chatMode !== "user" || !selectedUser) return;

        if (!typing) {

            typing = true;

            socket.emit("typing", {

                sender: username,
                receiver: selectedUser

            });

        }

        clearTimeout(typingTimer);

        typingTimer = setTimeout(() => {

            typing = false;

            socket.emit("stopTyping", {

                sender: username,
                receiver: selectedUser

            });

        }, 1000);

    });

document
    .getElementById("msg")
    .addEventListener("keypress", function (e) {

        if (e.key === "Enter") {

            sendMessage();

        }

    });

/* =====================================================
   MESSAGE RENDERING (bubbles + hover actions)
   ===================================================== */

// Normalizes the different shapes ("message" event / imageMessage / voiceMessage / privateHistory doc)
// into one consistent object the renderer understands.
function normalizeMessage(raw) {

    return {
        id: raw.id || (raw._id ? raw._id.toString() : null),
        sender: raw.sender || raw.user,
        receiver: raw.receiver,
        groupId: raw.groupId || null,
        text: raw.text,
        image: raw.image,
        voice: raw.voice,
        duration: raw.duration || null,
        reply: raw.reply || null,
        delivered: !!raw.delivered,
        seen: !!raw.seen,
        deleted: !!raw.deleted,
        starredBy: raw.starredBy || [],
        pinned: !!raw.pinned,
        forwarded: !!raw.forwarded,
        time: raw.time || new Date()
    };

}

// Shows a friendly placeholder when a conversation has no messages yet.
function showEmptyConversationState() {

    const box = document.getElementById("messages");
    box.innerHTML = `
        <div class="empty-chat-state">
            <i data-lucide="message-circle"></i>
            <p>Start a conversation</p>
        </div>
    `;
    refreshIcons();

}

function renderMessage(rawMsg) {

    const msg = normalizeMessage(rawMsg);

    const box = document.getElementById("messages");

    // A real message arrived, so the "Start a conversation" placeholder (if any) no longer applies.
    const emptyState = box.querySelector(".empty-chat-state");
    if (emptyState) emptyState.remove();

    const div = document.createElement("div");

    const outgoing = msg.sender === username;

    div.className = "message " + (outgoing ? "outgoing" : "incoming");
    div.id = "msg_" + msg.id;
    div.dataset.id = msg.id;

    let tick = "";
    if (outgoing) {
        tick = msg.seen ? "✓✓" : (msg.delivered ? "✓" : "");
    }

    let bodyHtml = "";

    if (msg.forwarded) {
        bodyHtml += `<div class="msg-forwarded-tag"><i data-lucide="corner-up-right"></i> Forwarded</div>`;
    }

    if (!outgoing) {
        bodyHtml += `<div class="msg-sender">${escapeHtml(msg.sender)}</div>`;
    }

    if (msg.reply) {
        bodyHtml += `<div class="msg-reply-quote"><b>${escapeHtml(msg.reply.sender)}</b><br>${escapeHtml(msg.reply.text)}</div>`;
    }

    if (msg.deleted) {

        bodyHtml += `<div class="msg-text" style="font-style:italic;color:var(--text-secondary)">This message was deleted</div>`;

    } else if (msg.text) {

        bodyHtml += `<div class="msg-text" id="msgText_${msg.id}">${escapeHtml(msg.text)}</div>`;

    } else if (msg.image) {

        bodyHtml += `<img src="${msg.image}" alt="image">`;

    } else if (msg.voice) {

        bodyHtml += `<div class="voice-msg"><audio controls src="${msg.voice}"></audio>${msg.duration ? `<span class="voice-duration">${formatDuration(msg.duration)}</span>` : ""}</div>`;

    }

    const isStarred = msg.starredBy.includes(username);

    bodyHtml += `
        <div class="msg-meta">
            ${isStarred ? '<i data-lucide="star" class="msg-star-indicator" style="fill:currentColor"></i>' : ""}
            <span>${formatTime(msg.time)}</span>
            <span id="status_${msg.id}" style="color:${msg.seen ? "#34B7F1" : "inherit"}">${escapeHtml(tick)}</span>
        </div>
    `;

    div.innerHTML = `
        <div class="bubble">${bodyHtml}</div>
        <span class="msg-menu-btn"><i data-lucide="chevron-down"></i></span>
        <div class="msg-menu">
            ${!msg.deleted && msg.text ? '<div class="copy-msg"><i data-lucide="copy"></i> Copy</div>' : ""}
            <div class="reply-msg"><i data-lucide="reply"></i> Reply</div>
            ${!msg.deleted ? '<div class="forward-msg"><i data-lucide="corner-up-right"></i> Forward</div>' : ""}
            <div class="star-msg"><i data-lucide="star"></i> ${isStarred ? "Unstar" : "Star"}</div>
            <div class="pin-msg"><i data-lucide="pin"></i> ${msg.pinned ? "Unpin" : "Pin"}</div>
            ${outgoing && msg.text && !msg.deleted ? '<div class="edit-msg"><i data-lucide="pencil"></i> Edit</div>' : ""}
            ${!msg.deleted ? '<div class="delete-msg"><i data-lucide="trash-2"></i> Delete</div>' : ""}
        </div>
    `;

    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    wireMessageMenu(div, msg);

    refreshIcons();

    return div;

}

function wireMessageMenu(div, msg) {

    const menuBtn = div.querySelector(".msg-menu-btn");
    const menu = div.querySelector(".msg-menu");

    menuBtn.onclick = function (e) {

        e.stopPropagation();

        document.querySelectorAll(".msg-menu").forEach(m => {
            if (m !== menu) m.classList.remove("show");
        });

        menu.classList.toggle("show");

    };

    const copyBtn = div.querySelector(".copy-msg");
    if (copyBtn) {
        copyBtn.onclick = function () {

            const text = msg.text || "";

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => showToast("Copied"));
            } else {
                // Fallback for older/mobile browsers without Clipboard API access
                const tmp = document.createElement("textarea");
                tmp.value = text;
                document.body.appendChild(tmp);
                tmp.select();
                document.execCommand("copy");
                tmp.remove();
                showToast("Copied");
            }

            menu.classList.remove("show");

        };
    }

    const replyBtn = div.querySelector(".reply-msg");
    replyBtn.onclick = function () {

        replyMessage = {
            sender: msg.sender,
            text: msg.text || (msg.image ? "📷 Photo" : msg.voice ? "🎤 Voice message" : "")
        };

        const preview = document.getElementById("replyPreview");
        preview.innerHTML = `<b>${escapeHtml(msg.sender)}</b><br>${escapeHtml(replyMessage.text)}`;
        preview.style.display = "block";

        menu.classList.remove("show");
        document.getElementById("msg").focus();

    };

    const forwardBtn = div.querySelector(".forward-msg");
    if (forwardBtn) {
        forwardBtn.onclick = function () {
            openForwardModal(msg);
            menu.classList.remove("show");
        };
    }

    const starBtn = div.querySelector(".star-msg");
    starBtn.onclick = function () {
        socket.emit("toggleStar", { id: msg.id, username: username });
        menu.classList.remove("show");
    };

    const pinBtn = div.querySelector(".pin-msg");
    pinBtn.onclick = function () {
        socket.emit("togglePin", {
            id: msg.id,
            sender: msg.sender,
            receiver: msg.sender === username ? msg.receiver : username,
            groupId: msg.groupId || undefined,
            pin: !msg.pinned
        });
        menu.classList.remove("show");
    };

    const editBtn = div.querySelector(".edit-msg");
    if (editBtn) {
        editBtn.onclick = function () {
            document.getElementById("msg").value = msg.text;
            editingMessageId = msg.id;
            menu.classList.remove("show");
            document.getElementById("msg").focus();
        };
    }

    const deleteBtn = div.querySelector(".delete-msg");
    if (deleteBtn) {
        deleteBtn.onclick = function () {

            const isOwn = msg.sender === username;

            const choice = isOwn
                ? confirm("OK = Delete for Everyone\n\nCancel = Delete for Me")
                : false;

            if (choice) {

                socket.emit("deleteMessage", {
                    id: msg.id,
                    type: "everyone",
                    username: username
                });

            } else {

                div.remove();

            }

            menu.classList.remove("show");

        };
    }

}

document.addEventListener("click", () => {

    document.querySelectorAll(".msg-menu").forEach(menu => {
        menu.classList.remove("show");
    });

});

/* =====================================================
   INCOMING SOCKET EVENTS
   ===================================================== */

// A message belongs in the currently visible chat pane only if it was
// exchanged between me and the user I currently have open.
function belongsToOpenConversation(data) {

    if (!selectedUser) return false;

    const sender = data.sender || data.user;
    const receiver = data.receiver;

    return (sender === username && receiver === selectedUser) ||
        (sender === selectedUser && receiver === username);

}

socket.on("message", (data) => {
    if (belongsToOpenConversation(data)) renderMessage(data);
});

socket.on("imageMessage", (data) => {
    if (belongsToOpenConversation(data)) renderMessage(data);
});

socket.on("voiceMessage", (data) => {
    if (belongsToOpenConversation(data)) renderMessage(data);
});

// Group messages only render if that exact group is currently open.
socket.on("groupMessage", (data) => {
    if (chatMode === "group" && data.groupId === selectedGroup) {
        renderMessage(data);
    }
});

socket.on("privateHistory", (messages) => {

    const box = document.getElementById("messages");
    box.innerHTML = "";

    if (!messages.length) {
        showEmptyConversationState();
        return;
    }

    messages.forEach((msg) => renderMessage(msg));

    box.scrollTop = box.scrollHeight;

});

socket.on("groupHistory", (data) => {

    if (chatMode !== "group" || data.groupId !== selectedGroup) return;

    const box = document.getElementById("messages");
    box.innerHTML = "";

    if (!data.messages.length) {
        showEmptyConversationState();
        return;
    }

    data.messages.forEach((msg) => renderMessage(msg));

    box.scrollTop = box.scrollHeight;

});

// Legacy/global history — kept for backward compatibility with the original feature.
// Only used before any conversation (private or group) is selected.
socket.on("chatHistory", (messages) => {

    if (chatMode) return;

    const box = document.getElementById("messages");
    box.innerHTML = "";

    messages.forEach((msg) => {

        const div = document.createElement("div");
        div.className = "message incoming";
        div.innerHTML = `<div class="bubble"><div class="msg-sender">${escapeHtml(msg.user)}</div><div class="msg-text">${escapeHtml(msg.text)}</div></div>`;
        box.appendChild(div);

    });

    box.scrollTop = box.scrollHeight;

});

socket.on("typing", (data) => {

    if (chatMode !== "user" || data.sender !== selectedUser) return;

    document.getElementById("typingStatus").innerHTML = "typing...";

});

socket.on("errorMessage", (data) => {
    showToast(data.message || "Something went wrong");
});

socket.on("groupCreated", (data) => {
    showToast(`Group "${data.name}" created`);
    closeGroupCreateModal();
    selectGroup(data.id);
});

socket.on("removedFromGroup", (data) => {

    showToast("You were removed from this group");

    if (chatMode === "group" && selectedGroup === data.groupId) {
        chatMode = "";
        selectedGroup = "";
        document.getElementById("chatUser").textContent = "Select a chat";
        document.getElementById("chatAvatar").innerHTML = "";
        document.getElementById("groupMembersBtn").style.display = "none";
        document.getElementById("messages").innerHTML = "";
    }

});

socket.on("groupMembersUpdated", (data) => {
    // If the group-info modal is currently showing this group, refresh it.
    if (currentGroupInfo && currentGroupInfo.groupId === data.groupId) {
        socket.emit("loadGroupMembers", { groupId: data.groupId });
    }
});

socket.on("stopTyping", () => {

    document.getElementById("typingStatus").innerHTML = "";

});

socket.on("seenMessages", (data) => {

    const status = document.getElementById("status_" + data.id);

    if (status) {

        status.innerHTML = "✓✓";
        status.style.color = "#34B7F1";

    }

});

socket.on("messageEdited", (data) => {

    const msgText = document.getElementById("msgText_" + data.id);

    if (msgText) {

        msgText.innerHTML = escapeHtml(data.text) + ' <small style="opacity:.6">(edited)</small>';

    }

});

socket.on("messageDeleted", (data) => {

    const msgText = document.getElementById("msgText_" + data.id);

    if (msgText) {

        msgText.innerHTML = "<i>This message was deleted</i>";
        msgText.style.color = "var(--text-secondary)";

    }

});

socket.on("messageStarUpdated", (data) => {

    if (data.username !== username) return;

    const div = document.getElementById("msg_" + data.id);

    if (div) {
        // Re-render the star indicator + menu label without losing the rest of the bubble
        const indicator = div.querySelector(".msg-star-indicator");
        const starLabel = div.querySelector(".star-msg");

        if (data.starred && !indicator) {
            const meta = div.querySelector(".msg-meta");
            const icon = document.createElement("i");
            icon.setAttribute("data-lucide", "star");
            icon.className = "msg-star-indicator";
            icon.style.fill = "currentColor";
            meta.prepend(icon);
            refreshIcons();
        } else if (!data.starred && indicator) {
            indicator.remove();
        }

        if (starLabel) starLabel.innerHTML = `<i data-lucide="star"></i> ${data.starred ? "Unstar" : "Star"}`;
        refreshIcons();
    }

    showToast(data.starred ? "Message starred" : "Message unstarred");

    if (document.getElementById("starredModal").style.display === "flex") {
        socket.emit("loadStarred", username);
    }

});

socket.on("messagePinUpdated", (data) => {

    const div = document.getElementById("msg_" + data.id);

    if (div) {
        const pinLabel = div.querySelector(".pin-msg");
        if (pinLabel) pinLabel.innerHTML = `<i data-lucide="pin"></i> ${data.pinned ? "Unpin" : "Pin"}`;
        refreshIcons();
    }

    showToast(data.pinned ? "Message pinned" : "Message unpinned");

    if (chatMode === "group" && selectedGroup) {
        socket.emit("loadPinned", { groupId: selectedGroup });
    } else if (chatMode === "user" && selectedUser) {
        socket.emit("loadPinned", { sender: username, receiver: selectedUser });
    }

});

/* =====================================================
   PINNED MESSAGES BAR + MODAL
   ===================================================== */

let currentPinned = [];

socket.on("pinnedMessages", (messages) => {

    currentPinned = messages;

    const bar = document.getElementById("pinnedBar");
    const text = document.getElementById("pinnedBarText");

    if (!messages.length) {
        bar.style.display = "none";
        return;
    }

    bar.style.display = "flex";
    const latest = messages[messages.length - 1];
    text.textContent = lastMessagePreview(normalizeMessage(latest));

    renderPinnedModalList();

});

function renderPinnedModalList() {

    const list = document.getElementById("pinnedList");
    list.innerHTML = "";

    currentPinned.forEach(raw => {

        const msg = normalizeMessage(raw);

        const li = document.createElement("li");
        li.innerHTML = `
            <div style="flex:1">
                <b>${escapeHtml(msg.sender)}</b>
                <div class="starred-meta">${escapeHtml(lastMessagePreview(msg))}</div>
            </div>
            <button class="icon-btn"><i data-lucide="pin-off"></i></button>
        `;

        li.querySelector("button").onclick = function () {
            socket.emit("togglePin", {
                id: msg.id,
                sender: msg.sender,
                receiver: msg.sender === username ? msg.receiver : username,
                groupId: msg.groupId || undefined,
                pin: false
            });
        };

        list.appendChild(li);

    });

    refreshIcons();

}

document.getElementById("pinnedListBtn").onclick = function () {
    document.getElementById("pinnedModal").style.display = "flex";
    renderPinnedModalList();
};

document.getElementById("pinnedBarExpand").onclick = function () {
    document.getElementById("pinnedModal").style.display = "flex";
    renderPinnedModalList();
};

document.getElementById("pinnedModalClose").onclick = function () {
    document.getElementById("pinnedModal").style.display = "none";
};

/* =====================================================
   STARRED MESSAGES MODAL
   ===================================================== */

document.getElementById("starredBtn").onclick = function () {
    document.getElementById("starredModal").style.display = "flex";
    socket.emit("loadStarred", username);
};

document.getElementById("starredModalClose").onclick = function () {
    document.getElementById("starredModal").style.display = "none";
};

socket.on("starredMessages", (messages) => {

    const list = document.getElementById("starredList");
    list.innerHTML = "";

    if (!messages.length) {
        list.innerHTML = `<li style="justify-content:center;color:var(--text-secondary)">No starred messages yet</li>`;
        return;
    }

    messages.forEach(raw => {

        const msg = normalizeMessage(raw);
        const otherParty = msg.sender === username ? msg.receiver : msg.sender;

        const li = document.createElement("li");
        li.innerHTML = msg.groupId ? `
            <div style="flex:1">
                <b>${escapeHtml(msg.sender)}</b> in a group
                <div class="starred-meta">${escapeHtml(lastMessagePreview(msg))} · ${formatContactTime(msg.time)}</div>
            </div>
        ` : `
            <div style="flex:1">
                <b>${escapeHtml(msg.sender)}</b> → ${escapeHtml(msg.receiver)}
                <div class="starred-meta">${escapeHtml(lastMessagePreview(msg))} · ${formatContactTime(msg.time)}</div>
            </div>
        `;

        li.onclick = function () {
            document.getElementById("starredModal").style.display = "none";
            if (msg.groupId) {
                selectGroup(msg.groupId);
            } else {
                selectUser(otherParty);
            }
        };

        list.appendChild(li);

    });

});

/* =====================================================
   FORWARD MODAL
   ===================================================== */

function openForwardModal(msg) {

    forwardTarget = msg;
    forwardSelected = new Set();

    document.getElementById("forwardSearch").value = "";
    renderForwardUserList("");

    document.getElementById("forwardModal").style.display = "flex";

}

function renderForwardUserList(filterText) {

    const list = document.getElementById("forwardUserList");
    list.innerHTML = "";

    const filter = (filterText || "").toLowerCase().trim();

    allContacts
        .filter(c => c.username.toLowerCase().includes(filter))
        .forEach(c => {

            const li = document.createElement("li");
            li.className = forwardSelected.has(c.username) ? "selected" : "";
            li.innerHTML = `
                <div class="contact-avatar" style="width:34px;height:34px;font-size:13px">${initials(c.username)}</div>
                <span>${escapeHtml(c.username)}</span>
            `;

            li.onclick = function () {
                if (forwardSelected.has(c.username)) {
                    forwardSelected.delete(c.username);
                } else {
                    forwardSelected.add(c.username);
                }
                renderForwardUserList(document.getElementById("forwardSearch").value);
            };

            list.appendChild(li);

        });

}

document.getElementById("forwardSearch").addEventListener("input", function () {
    renderForwardUserList(this.value);
});

document.getElementById("forwardModalClose").onclick = function () {
    document.getElementById("forwardModal").style.display = "none";
};

document.getElementById("forwardConfirmBtn").onclick = function () {

    if (!forwardTarget || forwardSelected.size === 0) {
        showToast("Select at least one user");
        return;
    }

    socket.emit("forwardMessage", {
        from: username,
        to: Array.from(forwardSelected),
        text: forwardTarget.text || null,
        image: forwardTarget.image || null,
        voice: forwardTarget.voice || null,
        originalSender: forwardTarget.sender
    });

    showToast("Message forwarded");

    document.getElementById("forwardModal").style.display = "none";

};

/* =====================================================
   IN-CHAT SEARCH (highlight, next/prev, count)
   ===================================================== */

let searchMatches = [];
let searchActiveIndex = -1;

function openSearchBar() {
    document.getElementById("chatSearchBar").classList.add("show");
    document.getElementById("chatSearchInput").value = "";
    document.getElementById("chatSearchInput").focus();
    clearSearchHighlights();
}

function closeSearchBar() {
    document.getElementById("chatSearchBar").classList.remove("show");
    clearSearchHighlights();
}

function clearSearchHighlights() {

    document.querySelectorAll("#messages .msg-text mark.search-hit").forEach(mark => {
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
    });

    searchMatches = [];
    searchActiveIndex = -1;
    document.getElementById("chatSearchCount").textContent = "0/0";

}

function runSearch(term) {

    clearSearchHighlights();

    if (!term.trim()) return;

    const lowerTerm = term.toLowerCase();

    document.querySelectorAll("#messages .msg-text").forEach(node => {

        const original = node.textContent;
        const lowerOriginal = original.toLowerCase();

        if (!lowerOriginal.includes(lowerTerm)) return;

        let html = "";
        let idx = 0;

        while (true) {
            const found = lowerOriginal.indexOf(lowerTerm, idx);
            if (found === -1) {
                html += escapeHtml(original.slice(idx));
                break;
            }
            html += escapeHtml(original.slice(idx, found));
            html += `<mark class="search-hit">${escapeHtml(original.slice(found, found + term.length))}</mark>`;
            idx = found + term.length;
        }

        node.innerHTML = html;

    });

    searchMatches = Array.from(document.querySelectorAll("#messages mark.search-hit"));

    document.getElementById("chatSearchCount").textContent = searchMatches.length ? `1/${searchMatches.length}` : "0/0";

    if (searchMatches.length) {
        searchActiveIndex = 0;
        focusSearchMatch();
    }

}

function focusSearchMatch() {

    searchMatches.forEach(m => m.classList.remove("active-hit"));

    if (searchActiveIndex < 0 || searchActiveIndex >= searchMatches.length) return;

    const active = searchMatches[searchActiveIndex];
    active.classList.add("active-hit");
    active.scrollIntoView({ block: "center", behavior: "smooth" });

    document.getElementById("chatSearchCount").textContent = `${searchActiveIndex + 1}/${searchMatches.length}`;

}

document.getElementById("chatSearchBtn").onclick = function () {

    const bar = document.getElementById("chatSearchBar");

    if (bar.classList.contains("show")) {
        closeSearchBar();
    } else {
        openSearchBar();
    }

};

document.getElementById("chatSearchClose").onclick = closeSearchBar;

document.getElementById("chatSearchInput").addEventListener("input", function () {
    runSearch(this.value);
});

document.getElementById("chatSearchNext").onclick = function () {
    if (!searchMatches.length) return;
    searchActiveIndex = (searchActiveIndex + 1) % searchMatches.length;
    focusSearchMatch();
};

document.getElementById("chatSearchPrev").onclick = function () {
    if (!searchMatches.length) return;
    searchActiveIndex = (searchActiveIndex - 1 + searchMatches.length) % searchMatches.length;
    focusSearchMatch();
};

document.getElementById("chatSearchInput").addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
        document.getElementById("chatSearchNext").click();
    }
});

/* =====================================================
   NEW GROUP MODAL
   ===================================================== */

let groupCreateSelectedMembers = new Set();
let groupPhotoFile = null;

function openGroupCreateModal() {

    groupCreateSelectedMembers = new Set();
    groupPhotoFile = null;

    document.getElementById("groupNameInput").value = "";
    document.getElementById("groupMemberSearch").value = "";
    document.getElementById("groupPhotoPreview").style.display = "none";
    document.getElementById("groupPhotoIcon").style.display = "block";

    renderGroupMemberList("");

    document.getElementById("groupCreateModal").style.display = "flex";

}

function closeGroupCreateModal() {
    document.getElementById("groupCreateModal").style.display = "none";
}

function renderGroupMemberList(search = "") {

    const list = document.getElementById("groupMemberList");
    list.innerHTML = "";

    const filter = search.trim().toLowerCase();

    const contacts = allContacts.filter(user => {

        const username = user.username || "";
        const name = user.name || "";

        return (
            username.toLowerCase().includes(filter) ||
            name.toLowerCase().includes(filter)
        );
    });

    contacts.forEach(user => {

        const username = user.username;

        const li = document.createElement("li");

        li.className = groupCreateSelectedMembers.has(username)
            ? "selected"
            : "";

        li.innerHTML = `
            <div class="contact-avatar">
                ${avatarHtml(user.name, user.avatar)}
            </div>
            <span>${escapeHtml(user.name)}</span>
        `;

        li.onclick = () => {

            if (groupCreateSelectedMembers.has(username)) {
                groupCreateSelectedMembers.delete(username);
            } else {
                groupCreateSelectedMembers.add(username);
            }

            renderGroupMemberList(search);
        };

        list.appendChild(li);
    });
}

document.getElementById("newGroupBtn").onclick = openGroupCreateModal;
document.getElementById("groupCreateModalClose").onclick = closeGroupCreateModal;

document.getElementById("groupMemberSearch").addEventListener("input", function () {
    renderGroupMemberList(this.value);
});

document.getElementById("groupPhotoPicker").onclick = function () {
    document.getElementById("groupPhotoInput").click();
};

document.getElementById("groupPhotoInput").addEventListener("change", function () {

    const file = this.files[0];
    if (!file) return;

    groupPhotoFile = file;

    const preview = document.getElementById("groupPhotoPreview");
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
    document.getElementById("groupPhotoIcon").style.display = "none";

});

document.getElementById("groupCreateConfirmBtn").onclick = async function () {

    const name = document.getElementById("groupNameInput").value.trim();

    if (!name) {
        showToast("Enter a group name");
        return;
    }

    if (groupCreateSelectedMembers.size === 0) {
        showToast("Add at least one member");
        return;
    }

    let imagePath = null;

    if (groupPhotoFile) {

        const formData = new FormData();
        formData.append("image", groupPhotoFile);

        try {
            const response = await fetch("/upload", { method: "POST", body: formData });
            const result = await response.json();
            if (result.success) imagePath = result.path;
        } catch (err) {
            console.error(err);
            showToast("Group photo upload failed, creating group without it");
        }

    }

    socket.emit("createGroup", {
        name,
        members: Array.from(groupCreateSelectedMembers),
        image: imagePath,
        creator: username
    });

};

/* =====================================================
   GROUP INFO MODAL (members, add/remove)
   ===================================================== */

let groupAddSelected = null;

function openGroupInfo(groupId) {
    currentGroupInfo = { groupId };
    socket.emit("loadGroupMembers", { groupId });
    document.getElementById("groupInfoModal").style.display = "flex";
}

function closeGroupInfoModal() {
    document.getElementById("groupInfoModal").style.display = "none";
    currentGroupInfo = null;
}

document.getElementById("groupInfoModalClose").onclick = closeGroupInfoModal;
document.getElementById("groupMembersBtn").onclick = function () {
    if (selectedGroup) openGroupInfo(selectedGroup);
};

socket.on("groupMembers", (data) => {

    // Only redraw if this is still the group the modal/user cares about.
    if (!currentGroupInfo || currentGroupInfo.groupId !== data.groupId) return;

    currentGroupInfo.creator = data.creator;
    currentGroupInfo.members = data.members;

    document.getElementById("groupInfoAvatar").innerHTML = avatarHtml(data.name, data.image);
    document.getElementById("groupInfoName").textContent = data.name;
    document.getElementById("groupInfoMemberCount").textContent = data.members.length + " member" + (data.members.length === 1 ? "" : "s");

    const isCreator = data.creator === username;

    document.getElementById("groupInfoAddRow").style.display = isCreator ? "block" : "none";
    if (isCreator) renderGroupAddMemberList("");

    const list = document.getElementById("groupInfoMemberList");
    list.innerHTML = "";

    data.members.forEach(m => {

        const li = document.createElement("li");
        li.innerHTML = `
            <div class="contact-avatar" style="width:34px;height:34px;font-size:13px">
                ${escapeHtml(initials(m.username))}
                <span class="online-dot ${m.online ? "online" : ""}"></span>
            </div>
            <span style="flex:1">${escapeHtml(m.username)} ${m.isCreator ? '<span class="creator-tag">Creator</span>' : ""}</span>
        `;

        const canRemove = (isCreator && !m.isCreator) || (!isCreator && m.username === username);

        if (canRemove) {
            const removeBtn = document.createElement("button");
            removeBtn.className = "icon-btn";
            removeBtn.innerHTML = m.username === username ? '<i data-lucide="log-out"></i>' : '<i data-lucide="user-minus"></i>';
            removeBtn.title = m.username === username ? "Leave group" : "Remove member";
            removeBtn.onclick = function () {
                socket.emit("removeGroupMember", { groupId: data.groupId, username: m.username, actor: username });
                if (m.username === username) closeGroupInfoModal();
            };
            li.appendChild(removeBtn);
        }

        list.appendChild(li);

    });

    refreshIcons();

});

function renderGroupAddMemberList(filterText) {

    const list = document.getElementById("groupAddMemberList");
    list.innerHTML = "";

    const filter = (filterText || "").toLowerCase().trim();
    const memberUsernames = new Set((currentGroupInfo.members || []).map(m => m.username));

    allContacts
        .filter(c => !memberUsernames.has(c.username) && c.username.toLowerCase().includes(filter))
        .forEach(c => {

            const li = document.createElement("li");
            li.innerHTML = `
                <div class="contact-avatar" style="width:34px;height:34px;font-size:13px">${avatarHtml(c.name || c.username, c.avatar)}</div>
                <span>${escapeHtml(c.name || c.username)}</span>
            `;

            li.onclick = function () {
                socket.emit("addGroupMember", { groupId: currentGroupInfo.groupId, username: c.username, actor: username });
            };

            list.appendChild(li);

        });

}

document.getElementById("groupAddMemberSearch").addEventListener("input", function () {
    if (currentGroupInfo) renderGroupAddMemberList(this.value);
});

/* =====================================================
   PROFILE MODAL (view own or another user's profile)
   ===================================================== */

let profileIsSelf = false;
let pendingAvatarFile = null;   // holds a picked file until "Save Changes" is pressed (preview-before-save)
let pendingAvatarRemoved = false;
let currentProfile = null;

function openProfile(targetUsername) {

    profileTargetUsername = targetUsername;

    fetch("/profile/" + encodeURIComponent(targetUsername))
        .then(res => res.json())
        .then(data => {

            if (!data.success) {
                showToast(data.message || "Could not load profile");
                return;
            }

            renderProfile(data.profile);
            document.getElementById("profileModal").style.display = "flex";

        })
        .catch(() => showToast("Could not load profile"));

}

function renderProfile(profile) {

    profileIsSelf = profile.isSelf;
    currentProfile = profile;
    pendingAvatarFile = null;
    pendingAvatarRemoved = false;

    document.getElementById("profileModalTitle").textContent = profile.isSelf ? "My Profile" : "Profile";
    document.getElementById("profileAvatar").innerHTML = avatarHtml(profile.name, profile.avatar);
    document.getElementById("profileAvatarActions").style.display = profile.isSelf ? "flex" : "none";

    document.getElementById("profileNameView").textContent = profile.name;
    document.getElementById("profileNameInput").value = profile.name;

    document.getElementById("profileUsernameView").textContent = "@" + profile.username;
    document.getElementById("profileUsernameInput").value = profile.username;
    document.getElementById("profileEmailView").textContent = profile.email;

    document.getElementById("profileBioView").textContent = profile.bio || "No bio yet";
    document.getElementById("profileBioInput").value = profile.bio || "";

    document.getElementById("profileStatusMsgView").textContent = profile.statusMessage || "Hey there! I am using Chat App.";
    document.getElementById("profileStatusMsgInput").value = profile.statusMessage || "";

    document.getElementById("profileStatusView").textContent = profile.online
        ? "Online"
        : (profile.lastSeen ? "Last seen " + formatContactTime(profile.lastSeen) + " at " + formatTime(profile.lastSeen) : "Offline");

    document.getElementById("profileJoinedView").textContent = profile.createdAt
        ? new Date(profile.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
        : "Unknown";

    if (profile.isSelf) buildWallpaperSwatches(typeof profile.wallpaper === "number" ? profile.wallpaper : wallpaperIndex);
    document.getElementById("profileWallpaperField").style.display = profile.isSelf ? "block" : "none";
    document.getElementById("profilePasswordSection").style.display = "none"; // only shown while editing

    exitProfileEditMode();
    document.getElementById("profileEditBtn").style.display = profile.isSelf ? "block" : "none";

}

function buildWallpaperSwatches(activeIndex) {
    const row = document.getElementById("wallpaperSwatchRow");
    row.innerHTML = "";
    WALLPAPERS.forEach((val, i) => {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "wallpaper-swatch" + (i === activeIndex ? " active" : "");
        swatch.style.backgroundImage = val === "none" ? "none" : val;
        swatch.title = i === 0 ? "No wallpaper" : "Wallpaper " + i;
        swatch.onclick = () => {
            wallpaperIndex = i;
            applyWallpaper(i);
            buildWallpaperSwatches(i);
            saveThemePreferences();
            showToast("Wallpaper updated");
        };
        row.appendChild(swatch);
    });
}

async function saveThemePreferences() {
    try {
        await fetch("/profile/preferences", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                theme: document.documentElement.getAttribute("data-theme") || "light",
                wallpaper: wallpaperIndex
            })
        });
    } catch (err) {
        console.error(err);
    }
}

function enterProfileEditMode() {

    document.getElementById("profileNameView").style.display = "none";
    document.getElementById("profileNameInput").style.display = "block";
    document.getElementById("profileUsernameView").style.display = "none";
    document.getElementById("profileUsernameInput").style.display = "block";
    document.getElementById("profileUsernameHint").style.display = "block";
    document.getElementById("profileBioView").style.display = "none";
    document.getElementById("profileBioInput").style.display = "block";
    document.getElementById("profileStatusMsgView").style.display = "none";
    document.getElementById("profileStatusMsgInput").style.display = "block";
    document.getElementById("profilePasswordSection").style.display = "block";

    document.getElementById("profileEditBtn").style.display = "none";
    document.getElementById("profileSaveBtn").style.display = "block";
    document.getElementById("profileCancelBtn").style.display = "block";

    refreshIcons();

}

function exitProfileEditMode() {

    document.getElementById("profileNameView").style.display = "block";
    document.getElementById("profileNameInput").style.display = "none";
    document.getElementById("profileUsernameView").style.display = "block";
    document.getElementById("profileUsernameInput").style.display = "none";
    document.getElementById("profileUsernameHint").style.display = "none";
    document.getElementById("profileBioView").style.display = "block";
    document.getElementById("profileBioInput").style.display = "none";
    document.getElementById("profileStatusMsgView").style.display = "block";
    document.getElementById("profileStatusMsgInput").style.display = "none";
    document.getElementById("profilePasswordSection").style.display = "none";

    document.getElementById("profileSaveBtn").style.display = "none";
    document.getElementById("profileCancelBtn").style.display = "none";
    pendingAvatarFile = null;
    pendingAvatarRemoved = false;
    if (currentProfile) document.getElementById("profileAvatar").innerHTML = avatarHtml(currentProfile.name, currentProfile.avatar);
    if (profileIsSelf) document.getElementById("profileEditBtn").style.display = "block";

}

document.getElementById("myProfileBtn").onclick = function () {
    openProfile(username);
};

document.getElementById("profileModalClose").onclick = function () {
    document.getElementById("profileModal").style.display = "none";
    exitProfileEditMode();
};

document.getElementById("profileEditBtn").onclick = enterProfileEditMode;
document.getElementById("profileCancelBtn").onclick = function () {
    if (currentProfile) renderProfile(currentProfile);
};

// ---- Preview-before-save: picking a photo only previews it locally;
// it's actually uploaded once "Save Changes" is clicked. ----
document.getElementById("profileChangePhotoBtn").onclick = function () {
    document.getElementById("profileAvatarInput").click();
};

document.getElementById("profileAvatarInput").addEventListener("change", function () {

    const file = this.files[0];
    if (!file) return;

    pendingAvatarFile = file;
    pendingAvatarRemoved = false;

    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById("profileAvatar").innerHTML =
            `<img src="${e.target.result}" class="avatar-img" alt="avatar preview">`;
    };
    reader.readAsDataURL(file);

    if (!profileIsSelf) return;
    enterProfileEditMode();

});

document.getElementById("profileRemovePhotoBtn").onclick = function () {
    pendingAvatarFile = null;
    pendingAvatarRemoved = true;
    document.getElementById("profileAvatar").innerHTML = avatarHtml(currentProfile ? currentProfile.name : username, null);
    enterProfileEditMode();
};

document.getElementById("profileSaveBtn").onclick = async function () {

    const name = document.getElementById("profileNameInput").value.trim() || username;
    const bio = document.getElementById("profileBioInput").value.trim();
    const statusMessage = document.getElementById("profileStatusMsgInput").value.trim();
    const newUsername = document.getElementById("profileUsernameInput").value.trim();

    this.disabled = true;
    this.textContent = "Saving...";

    try {

        // 1) Text fields
        const response = await fetch("/profile/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, bio, statusMessage })
        });
        const result = await response.json();
        if (!result.success) {
            showToast(result.message || "Update failed");
            return;
        }

        // 2) Avatar: upload new picture, or remove existing one
        if (pendingAvatarFile) {
            const formData = new FormData();
            formData.append("avatar", pendingAvatarFile);
            const avatarRes = await fetch("/profile/avatar", { method: "POST", body: formData });
            const avatarResult = await avatarRes.json();
            if (!avatarResult.success) showToast("Photo upload failed");
        } else if (pendingAvatarRemoved) {
            await fetch("/profile/avatar/remove", { method: "POST" });
        }

        socket.emit("loadContacts", username); // refresh so avatar/name changes show up for others

        // 3) Username change (separate flow — forces re-login on success)
        if (newUsername && newUsername !== username) {
            const uRes = await fetch("/profile/username", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ newUsername })
            });
            const uResult = await uRes.json();
            if (uResult.success && uResult.requireRelogin) {
                showToast("Username updated. Please log in again.");
                setTimeout(() => { window.location.href = "/"; }, 1200);
                return;
            } else if (!uResult.success) {
                showToast(uResult.message || "Username change failed");
            }
        }

        showToast("Profile updated");
        openProfile(username); // reload with fresh data

    } catch (err) {
        console.error(err);
        showToast("Update failed");
    } finally {
        this.disabled = false;
        this.textContent = "Save Changes";
    }

};

// ---- Password visibility toggles (profile + password fields) ----
document.querySelectorAll(".pw-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.innerHTML = showing ? '<i data-lucide="eye"></i>' : '<i data-lucide="eye-off"></i>';
        refreshIcons();
    });
});

// ---- Change password (separate, immediate action — not bundled into preview/save) ----
document.getElementById("profileChangePasswordBtn").onclick = async function () {

    const currentPassword = document.getElementById("profileCurrentPassword").value;
    const newPassword = document.getElementById("profileNewPassword").value;

    if (!currentPassword || !newPassword) {
        showToast("Enter both current and new password");
        return;
    }

    this.disabled = true;

    try {

        const res = await fetch("/profile/password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const result = await res.json();

        if (result.success) {
            showToast("Password updated");
            document.getElementById("profileCurrentPassword").value = "";
            document.getElementById("profileNewPassword").value = "";
        } else {
            showToast(result.message || "Password change failed");
        }

    } catch (err) {
        console.error(err);
        showToast("Password change failed");
    } finally {
        this.disabled = false;
    }

};

/* =====================================================
   LOGOUT
   ===================================================== */

document.getElementById("logoutBtn").onclick = function () {
    document.getElementById("logoutConfirmModal").style.display = "flex";
};

document.getElementById("logoutConfirmClose").onclick =
document.getElementById("logoutCancelBtn").onclick = function () {
    document.getElementById("logoutConfirmModal").style.display = "none";
};

document.getElementById("logoutConfirmBtn").onclick = async function () {

    this.disabled = true;
    this.textContent = "Logging out...";

    try {

        await fetch("/logout", { method: "POST" });

    } catch (err) {
        console.error(err);
    }

    // Always disconnect the live socket and redirect, even if the network
    // call above failed — a stuck "logged in" client is worse than a
    // client that's already headed back to the login page.
    socket.disconnect();
    showToast("Logged out successfully");
    setTimeout(() => { window.location.href = "/"; }, 400);

};

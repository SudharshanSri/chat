const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { connectDB, getDB } = require("./database/db");
const bcrypt = require("bcrypt");
const multer = require("multer");
const session = require("express-session");
const { ObjectId } = require("mongodb");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static("uploads"));
app.use("/voices", express.static("voices"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: "chatapplication",
    resave: false,
    saveUninitialized: true
}));

/* =====================================================
   FILE UPLOAD STORAGE
   (unchanged locations: uploads/ for images+avatars+group
   photos, voices/ for voice notes — keeps project structure
   the same, no GridFS needed)
   ===================================================== */

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});

const voiceStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "voices/"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });
const voiceUpload = multer({ storage: voiceStorage });

/* =====================================================
   IN-MEMORY PRESENCE STATE
   ===================================================== */

let users = {};        // socket.id -> username (kept for the legacy "userList" broadcast)
let userSockets = {};  // username  -> socket.id

/* =====================================================
   HELPERS
   ===================================================== */

// Wraps a socket handler so a thrown/rejected error can't crash the
// server or hang the client silently — the client gets an "errorMessage".
function safe(socket, handler) {
    return async (...args) => {
        try {
            await handler(...args);
        } catch (err) {
            console.error("Socket handler error:", err);
            socket.emit("errorMessage", { message: "Something went wrong. Please try again." });
        }
    };
}

// Builds the sidebar contact list (all users + last message + unread count + online flag)
async function buildContacts(username) {

    const db = getDB();

    const allUsers = await db.collection("users")
        .find({ username: { $ne: username } })
        .project({ username: 1, avatar: 1, name: 1, _id: 0 })
        .toArray();

    const contacts = [];

    for (const u of allUsers) {

        const lastMsg = await db.collection("messages")
            .find({
                $or: [
                    { sender: username, receiver: u.username },
                    { sender: u.username, receiver: username }
                ]
            })
            .sort({ time: -1 })
            .limit(1)
            .toArray();

        const unreadCount = await db.collection("messages").countDocuments({
            sender: u.username,
            receiver: username,
            seen: false
        });

        contacts.push({
            username: u.username,
            name: u.name || u.username,
            avatar: u.avatar || null,
            lastMessage: lastMsg[0] || null,
            unreadCount,
            online: !!userSockets[u.username]
        });

    }

    contacts.sort((a, b) => {
        const at = a.lastMessage ? new Date(a.lastMessage.time).getTime() : 0;
        const bt = b.lastMessage ? new Date(b.lastMessage.time).getTime() : 0;
        return bt - at;
    });

    return contacts;

}

// Builds the list of groups a user belongs to (+ last message + unread count)
async function buildGroups(username) {

    const db = getDB();

    const groups = await db.collection("groups")
        .find({ members: username })
        .toArray();

    const result = [];

    for (const g of groups) {

        const lastMsg = await db.collection("messages")
            .find({ groupId: g._id.toString() })
            .sort({ time: -1 })
            .limit(1)
            .toArray();

        const unreadCount = await db.collection("messages").countDocuments({
            groupId: g._id.toString(),
            sender: { $ne: username },
            seenBy: { $ne: username }
        });

        result.push({
            id: g._id.toString(),
            name: g.name,
            image: g.image || null,
            creator: g.creator,
            memberCount: g.members.length,
            lastMessage: lastMsg[0] || null,
            unreadCount,
            online: g.members.some(m => m !== username && !!userSockets[m])
        });

    }

    result.sort((a, b) => {
        const at = a.lastMessage ? new Date(a.lastMessage.time).getTime() : 0;
        const bt = b.lastMessage ? new Date(b.lastMessage.time).getTime() : 0;
        return bt - at;
    });

    return result;

}

// Pushes a fresh contact list to a given username, if they're online
async function pushContactsTo(username) {
    const sid = userSockets[username];
    if (!sid) return;
    const contacts = await buildContacts(username);
    io.to(sid).emit("contactsList", contacts);
}

// Pushes a fresh group list to a given username, if they're online
async function pushGroupsTo(username) {
    const sid = userSockets[username];
    if (!sid) return;
    const groups = await buildGroups(username);
    io.to(sid).emit("groupsList", groups);
}

function groupRoom(groupId) {
    return "group_" + groupId;
}

/* =====================================================
   AUTH-GUARDED PAGE / SESSION ROUTES (unchanged)
   ===================================================== */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/signup", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "signup.html"));
});

app.get("/chat", (req, res) => {
    if (!req.session.username) return res.redirect("/");
    res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.get("/username", (req, res) => {
    if (!req.session.username) return res.send("");
    res.send(req.session.username);
});

function requireAuth(req, res, next) {
    if (!req.session.username) return res.status(401).json({ success: false, message: "Not logged in" });
    next();
}

/* =====================================================
   FILE UPLOAD ROUTES (unchanged behavior)
   ===================================================== */

app.post("/upload", upload.single("image"), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false });
    res.json({ success: true, path: "/uploads/" + req.file.filename });
});

app.post("/uploadVoice", voiceUpload.single("voice"), (req, res) => {
    if (!req.file) return res.json({ success: false });
    res.json({ success: true, path: "/voices/" + req.file.filename });
});

/* =====================================================
   LOGIN / SIGNUP
   ===================================================== */

app.post("/login", async (req, res) => {

    try {

        const db = getDB();
        const username = (req.body.a || "").trim();
        const password = req.body.b || "";
        const remember = !!req.body.remember;

        const user = await db.collection("users").findOne({ username });

        if (!user) return res.status(401).json({ success: false, message: "User not found" });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ success: false, message: "Incorrect password" });

        req.session.username = username;

        // "Remember me" extends the session cookie lifetime to 30 days;
        // otherwise it stays a normal browser-session cookie.
        if (remember) {
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        }

        res.json({ success: true, redirect: "/chat" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Login failed. Please try again." });
    }

});

app.post("/signup", async (req, res) => {

    try {

        const db = getDB();
        const { username, email, password } = req.body;

        if (!username || !username.trim() || !email || !password) {
            return res.status(400).json({ success: false, message: "All fields are required" });
        }

        // BUGFIX: the original code only checked email uniqueness, so two
        // accounts could silently share the same username (breaking DMs,
        // since users/messages are keyed by username). Now checks both.
        const existingEmail = await db.collection("users").findOne({ email });
        if (existingEmail) return res.status(409).json({ success: false, message: "Email already exists" });

        const existingUsername = await db.collection("users").findOne({ username: username.trim() });
        if (existingUsername) return res.status(409).json({ success: false, message: "Username already taken" });

        if (password.length < 6) return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });

        const hashedPassword = await bcrypt.hash(password, 10);

        await db.collection("users").insertOne({
            username: username.trim(),
            email,
            password: hashedPassword,
            name: username.trim(),
            bio: "",
            statusMessage: "Hey there! I am using Chat App.",
            avatar: null,
            theme: "light",
            wallpaper: 0,
            createdAt: new Date(),
            lastSeen: new Date()
        });

        console.log("New User :", username);

        // Refresh every currently-connected user's sidebar so the new user
        // shows up immediately, without requiring a manual reload.
        Object.keys(userSockets).forEach(u => pushContactsTo(u));

        res.json({ success: true, redirect: "/" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Signup failed. Please try again." });
    }

});

/* =====================================================
   PROFILE ROUTES
   ===================================================== */

app.get("/profile/:username", requireAuth, async (req, res) => {

    try {

        const db = getDB();
        const user = await db.collection("users").findOne(
            { username: req.params.username },
            { projection: { password: 0 } }
        );

        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const isSelf = req.session.username === user.username;

        res.json({
            success: true,
            profile: {
                username: user.username,
                name: user.name || user.username,
                email: user.email,
                bio: user.bio || "",
                statusMessage: user.statusMessage || "Hey there! I am using Chat App.",
                avatar: user.avatar || null,
                createdAt: user.createdAt || null,
                lastSeen: user.lastSeen || null,
                online: !!userSockets[user.username],
                isSelf,
                // Theme/wallpaper are personal preferences — only ever sent
                // back to the owner of the profile, never to viewers of it.
                theme: isSelf ? (user.theme || "light") : undefined,
                wallpaper: isSelf ? (typeof user.wallpaper === "number" ? user.wallpaper : 0) : undefined
            }
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Failed to load profile" });
    }

});

app.post("/profile/update", requireAuth, async (req, res) => {

    try {

        const db = getDB();
        const { name, bio, statusMessage } = req.body;

        const update = {
            name: (name || req.session.username).trim(),
            bio: (bio || "").trim()
        };

        if (typeof statusMessage === "string") {
            update.statusMessage = statusMessage.trim().slice(0, 120);
        }

        await db.collection("users").updateOne(
            { username: req.session.username },
            { $set: update }
        );

        res.json({ success: true });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Failed to update profile" });
    }

});

// ---- Remove profile picture ----
app.post("/profile/avatar/remove", requireAuth, async (req, res) => {

    try {

        const db = getDB();

        await db.collection("users").updateOne(
            { username: req.session.username },
            { $set: { avatar: null } }
        );

        res.json({ success: true });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Failed to remove photo" });
    }

});

// ---- Change password (requires current password) ----
app.post("/profile/password", requireAuth, async (req, res) => {

    try {

        const db = getDB();
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: "Both fields are required" });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
        }

        const user = await db.collection("users").findOne({ username: req.session.username });
        const match = await bcrypt.compare(currentPassword, user.password);
        if (!match) return res.status(401).json({ success: false, message: "Current password is incorrect" });

        const hashed = await bcrypt.hash(newPassword, 10);

        await db.collection("users").updateOne(
            { username: req.session.username },
            { $set: { password: hashed } }
        );

        res.json({ success: true });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Failed to change password" });
    }

});

// ---- Change username ----
// This touches multiple collections (users, messages, groups) plus the
// live in-memory socket map, so — to avoid any risk of a half-updated,
// inconsistent state while the user is mid-conversation — we require the
// user to log back in afterward instead of trying to hot-swap their
// live session and every open socket room in place.
app.post("/profile/username", requireAuth, async (req, res) => {

    try {

        const db = getDB();
        const oldUsername = req.session.username;
        const newUsername = (req.body.newUsername || "").trim();

        if (!newUsername) return res.status(400).json({ success: false, message: "Username cannot be empty" });
        if (newUsername === oldUsername) return res.json({ success: true, unchanged: true });

        const existing = await db.collection("users").findOne({ username: newUsername });
        if (existing) return res.status(409).json({ success: false, message: "Username already taken" });

        await db.collection("users").updateOne({ username: oldUsername }, { $set: { username: newUsername } });

        await db.collection("messages").updateMany({ sender: oldUsername }, { $set: { sender: newUsername } });
        await db.collection("messages").updateMany({ receiver: oldUsername }, { $set: { receiver: newUsername } });
        await db.collection("messages").updateMany({ starredBy: oldUsername }, { $set: { "starredBy.$": newUsername } });
        await db.collection("messages").updateMany({ seenBy: oldUsername }, { $set: { "seenBy.$": newUsername } });

        await db.collection("groups").updateMany({ members: oldUsername }, { $set: { "members.$": newUsername } });
        await db.collection("groups").updateMany({ creator: oldUsername }, { $set: { creator: newUsername } });

        // Force re-login so the session, socket map, and joined group rooms
        // can't end up referencing the stale username.
        req.session.destroy(() => {
            res.json({ success: true, requireRelogin: true });
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Failed to change username" });
    }

});

// ---- Save theme / wallpaper preference to MongoDB ----
app.post("/profile/preferences", requireAuth, async (req, res) => {

    try {

        const db = getDB();
        const { theme, wallpaper } = req.body;

        const update = {};
        if (theme === "light" || theme === "dark") update.theme = theme;
        if (typeof wallpaper === "number") update.wallpaper = wallpaper;

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ success: false, message: "Nothing to update" });
        }

        await db.collection("users").updateOne(
            { username: req.session.username },
            { $set: update }
        );

        res.json({ success: true });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Failed to save preferences" });
    }

});

/* =====================================================
   LOGOUT
   ===================================================== */

app.post("/logout", (req, res) => {

    const username = req.session.username;

    req.session.destroy((err) => {

        if (err) {
            console.log(err);
            return res.status(500).json({ success: false, message: "Logout failed" });
        }

        res.clearCookie("connect.sid");

        // Force-disconnect any live socket for this user so a stale
        // connection can't keep receiving events after logout.
        if (username && userSockets[username]) {
            const sid = userSockets[username];
            io.sockets.sockets.get(sid)?.disconnect(true);
        }

        res.json({ success: true, redirect: "/" });

    });

});

app.post("/profile/avatar", requireAuth, upload.single("avatar"), async (req, res) => {

    try {

        if (!req.file) return res.status(400).json({ success: false });

        const db = getDB();
        const avatarPath = "/uploads/" + req.file.filename;

        await db.collection("users").updateOne(
            { username: req.session.username },
            { $set: { avatar: avatarPath } }
        );

        res.json({ success: true, path: avatarPath });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Failed to update avatar" });
    }

});

/* =====================================================
   SOCKET.IO
   ===================================================== */

io.on("connection", (socket) => {

    console.log("User Connected");

    socket.on("join", safe(socket, async (username) => {

        console.log("JOIN REQUEST :", username);

        socket.username = username;
        users[socket.id] = username;
        userSockets[username] = socket.id;

        // Auto-join every group room this user belongs to, so real-time
        // group messages reach them without any extra client action.
        const db = getDB();
        const groups = await db.collection("groups").find({ members: username }).toArray();
        groups.forEach(g => socket.join(groupRoom(g._id.toString())));

        io.emit("userList", Object.values(users));

        pushContactsTo(username);
        pushGroupsTo(username);

        // Let everyone else refresh their online indicator for this user
        Object.keys(userSockets).forEach(u => {
            if (u !== username) pushContactsTo(u);
        });

    }));

    /* ---------- PRIVATE MESSAGES ---------- */

    // Shared insert+deliver logic for text/image/voice private messages.
    // Fixes two bugs from the original version:
    //   1. The "delivered" flag used to be updated with an ambiguous filter
    //      (sender+receiver+text) which could mark the WRONG message as
    //      delivered if the same text was sent twice. Now updates by _id.
    //   2. If a user messaged themselves, the same socket got the "message"
    //      event twice (once as receiver, once as sender echo). Now guarded.
    async function sendPrivateContent(socket, data, contentField, eventName) {

        const db = getDB();

        const doc = {
            sender: data.sender,
            receiver: data.receiver,
            reply: data.reply || null,
            delivered: false,
            seen: false,
            starredBy: [],
            pinned: false,
            forwarded: !!data.forwarded,
            time: new Date(),
            [contentField]: data[contentField]
        };

        const result = await db.collection("messages").insertOne(doc);
        const receiverSocket = userSockets[data.receiver];
        const isSelfChat = receiverSocket === socket.id;

        const payload = {
            id: result.insertedId.toString(),
            user: data.sender,
            sender: data.sender,
            receiver: data.receiver,
            reply: data.reply,
            starredBy: [],
            pinned: false,
            forwarded: !!data.forwarded,
            time: doc.time,
            [contentField]: data[contentField]
        };

        if (receiverSocket && !isSelfChat) {
            io.to(receiverSocket).emit(eventName, { ...payload, delivered: true });
            await db.collection("messages").updateOne(
                { _id: result.insertedId },
                { $set: { delivered: true } }
            );
        }

        socket.emit(eventName, { ...payload, delivered: !!receiverSocket });

        pushContactsTo(data.sender);
        pushContactsTo(data.receiver);

    }

    socket.on("privateMessage", safe(socket, async (data) => {
        await sendPrivateContent(socket, data, "text", "message");
    }));

    socket.on("privateImage", safe(socket, async (data) => {
        await sendPrivateContent(socket, data, "image", "imageMessage");
    }));

    socket.on("privateVoice", safe(socket, async (data) => {
        await sendPrivateContent(socket, data, "voice", "voiceMessage");
    }));

    /* ---------- GROUP CHAT ---------- */

    socket.on("createGroup", safe(socket, async (data) => {

        // data: { name, members: [usernames incl. creator], image, creator }
        const db = getDB();

        const members = Array.from(new Set([...(data.members || []), data.creator]));

        const group = {
            name: (data.name || "New Group").trim(),
            image: data.image || null,
            members,
            creator: data.creator,
            createdAt: new Date()
        };

        const result = await db.collection("groups").insertOne(group);
        const groupId = result.insertedId.toString();

        members.forEach(m => {
            const sid = userSockets[m];
            if (sid) io.sockets.sockets.get(sid)?.join(groupRoom(groupId));
            pushGroupsTo(m);
        });

        socket.emit("groupCreated", { id: groupId, name: group.name });

    }));

    socket.on("groupMessage", safe(socket, async (data) => {

        // data: { groupId, sender, text?, image?, voice?, reply? }
        const db = getDB();

        const group = await db.collection("groups").findOne({ _id: new ObjectId(data.groupId) });
        if (!group || !group.members.includes(data.sender)) return; // not a member, ignore

        const doc = {
            groupId: data.groupId,
            sender: data.sender,
            reply: data.reply || null,
            starredBy: [],
            pinned: false,
            forwarded: !!data.forwarded,
            seenBy: [data.sender],
            time: new Date()
        };

        if (data.text) doc.text = data.text;
        if (data.image) doc.image = data.image;
        if (data.voice) doc.voice = data.voice;

        const result = await db.collection("messages").insertOne(doc);

        // Every member's socket is already joined to this room (see "join"
        // and "createGroup"), so ONE emit reaches everyone including the
        // sender — no separate self-echo needed, which avoids duplicates.
        io.to(groupRoom(data.groupId)).emit("groupMessage", {
            id: result.insertedId.toString(),
            user: data.sender,
            sender: data.sender,
            groupId: data.groupId,
            text: doc.text,
            image: doc.image,
            voice: doc.voice,
            reply: doc.reply,
            starredBy: [],
            pinned: false,
            forwarded: doc.forwarded,
            time: doc.time
        });

        group.members.forEach(m => pushGroupsTo(m));

    }));

    socket.on("loadGroups", safe(socket, async (username) => {
        const groups = await buildGroups(username);
        socket.emit("groupsList", groups);
    }));

    socket.on("loadGroupMessages", safe(socket, async (data) => {

        // data: { groupId, username }
        const db = getDB();

        const messages = await db.collection("messages")
            .find({ groupId: data.groupId })
            .sort({ time: 1 })
            .toArray();

        socket.emit("groupHistory", { groupId: data.groupId, messages });

        // Mark all as seen by this user, then refresh their unread badge.
        await db.collection("messages").updateMany(
            { groupId: data.groupId, seenBy: { $ne: data.username } },
            { $addToSet: { seenBy: data.username } }
        );

        pushGroupsTo(data.username);

    }));

    socket.on("loadGroupMembers", safe(socket, async (data) => {

        // data: { groupId }
        const db = getDB();
        const group = await db.collection("groups").findOne({ _id: new ObjectId(data.groupId) });
        if (!group) return;

        const members = group.members.map(m => ({
            username: m,
            online: !!userSockets[m],
            isCreator: m === group.creator
        }));

        socket.emit("groupMembers", { groupId: data.groupId, name: group.name, image: group.image, creator: group.creator, members });

    }));

    socket.on("addGroupMember", safe(socket, async (data) => {

        // data: { groupId, username, actor }
        const db = getDB();
        const group = await db.collection("groups").findOne({ _id: new ObjectId(data.groupId) });
        if (!group || group.creator !== data.actor) return; // only the creator manages membership

        await db.collection("groups").updateOne(
            { _id: new ObjectId(data.groupId) },
            { $addToSet: { members: data.username } }
        );

        const sid = userSockets[data.username];
        if (sid) io.sockets.sockets.get(sid)?.join(groupRoom(data.groupId));

        const updated = await db.collection("groups").findOne({ _id: new ObjectId(data.groupId) });
        updated.members.forEach(m => pushGroupsTo(m));

        io.to(groupRoom(data.groupId)).emit("groupMembersUpdated", { groupId: data.groupId });

    }));

    socket.on("removeGroupMember", safe(socket, async (data) => {

        // data: { groupId, username, actor } — actor must be the creator, or removing themself
        const db = getDB();
        const group = await db.collection("groups").findOne({ _id: new ObjectId(data.groupId) });
        if (!group) return;
        if (group.creator !== data.actor && data.actor !== data.username) return;

        await db.collection("groups").updateOne(
            { _id: new ObjectId(data.groupId) },
            { $pull: { members: data.username } }
        );

        const sid = userSockets[data.username];
        if (sid) {
            io.sockets.sockets.get(sid)?.leave(groupRoom(data.groupId));
            io.to(sid).emit("removedFromGroup", { groupId: data.groupId });
        }

        pushGroupsTo(data.username);

        const updated = await db.collection("groups").findOne({ _id: new ObjectId(data.groupId) });
        if (updated) {
            updated.members.forEach(m => pushGroupsTo(m));
            io.to(groupRoom(data.groupId)).emit("groupMembersUpdated", { groupId: data.groupId });
        }

    }));

    /* ---------- TYPING (private only — unchanged) ---------- */

    socket.on("typing", (data) => {
        const receiverSocket = userSockets[data.receiver];
        if (receiverSocket) io.to(receiverSocket).emit("typing", { sender: data.sender });
    });

    socket.on("stopTyping", (data) => {
        const receiverSocket = userSockets[data.receiver];
        if (receiverSocket) io.to(receiverSocket).emit("stopTyping");
    });

    /* ---------- DISCONNECT ---------- */

    socket.on("disconnect", safe(socket, async () => {

        const leftUser = socket.username;

        delete users[socket.id];
        delete userSockets[socket.username];

        io.emit("userList", Object.values(users));

        if (leftUser) {

            const db = getDB();
            await db.collection("users").updateOne(
                { username: leftUser },
                { $set: { lastSeen: new Date() } }
            );

            Object.keys(userSockets).forEach(u => pushContactsTo(u));

            io.emit("message", {
                user: "System",
                text: leftUser + " left the chat"
            });

        }

    }));

    /* ---------- LEGACY GLOBAL HISTORY (unchanged) ---------- */

    socket.on("loadMessages", safe(socket, async () => {
        const db = getDB();
        const messages = await db.collection("messages").find({}).sort({ time: 1 }).toArray();
        socket.emit("chatHistory", messages);
    }));

    /* ---------- PRIVATE HISTORY (unchanged) ---------- */

    socket.on("loadPrivateMessages", safe(socket, async (data) => {
        const db = getDB();
        const messages = await db.collection("messages")
            .find({
                $or: [
                    { sender: data.sender, receiver: data.receiver },
                    { sender: data.receiver, receiver: data.sender }
                ]
            })
            .sort({ time: 1 })
            .toArray();
        socket.emit("privateHistory", messages);
    }));

    /* ---------- SEEN RECEIPTS (unchanged) ---------- */

    socket.on("seenMessages", safe(socket, async (data) => {

        const db = getDB();

        const messages = await db.collection("messages")
            .find({ sender: data.sender, receiver: data.receiver, seen: false })
            .toArray();

        await db.collection("messages").updateMany(
            { sender: data.sender, receiver: data.receiver, seen: false },
            { $set: { seen: true } }
        );

        const senderSocket = userSockets[data.sender];
        if (senderSocket) {
            messages.forEach(msg => {
                io.to(senderSocket).emit("seenMessages", { id: msg._id.toString() });
            });
        }

        pushContactsTo(data.receiver);

    }));

    /* ---------- EDIT / DELETE (now scoped instead of global-broadcast) ---------- */

    socket.on("editMessage", safe(socket, async (data) => {

        const db = getDB();
        const existing = await db.collection("messages").findOne({ _id: new ObjectId(data.id) });
        if (!existing || existing.sender !== data.username) return;

        await db.collection("messages").updateOne(
            { _id: new ObjectId(data.id) },
            { $set: { text: data.text, edited: true } }
        );

        const payload = { id: data.id, text: data.text };

        if (existing.groupId) {
            io.to(groupRoom(existing.groupId)).emit("messageEdited", payload);
        } else {
            [userSockets[existing.sender], userSockets[existing.receiver]].forEach(sid => {
                if (sid) io.to(sid).emit("messageEdited", payload);
            });
        }

    }));

    socket.on("deleteMessage", safe(socket, async (data) => {

        const db = getDB();

        if (data.type !== "everyone") return;

        const existing = await db.collection("messages").findOne({ _id: new ObjectId(data.id) });
        if (!existing || existing.sender !== data.username) return;

        await db.collection("messages").updateOne(
            { _id: new ObjectId(data.id) },
            { $set: { deleted: true } }
        );

        const payload = { id: data.id, type: "everyone" };

        if (existing.groupId) {
            io.to(groupRoom(existing.groupId)).emit("messageDeleted", payload);
        } else {
            [userSockets[existing.sender], userSockets[existing.receiver]].forEach(sid => {
                if (sid) io.to(sid).emit("messageDeleted", payload);
            });
        }

    }));

    /* ---------- STAR (unchanged, already personal-scoped) ---------- */

    socket.on("toggleStar", safe(socket, async (data) => {

        const db = getDB();
        const msg = await db.collection("messages").findOne({ _id: new ObjectId(data.id) });
        if (!msg) return;

        const alreadyStarred = (msg.starredBy || []).includes(data.username);

        await db.collection("messages").updateOne(
            { _id: new ObjectId(data.id) },
            alreadyStarred
                ? { $pull: { starredBy: data.username } }
                : { $addToSet: { starredBy: data.username } }
        );

        const payload = { id: data.id, username: data.username, starred: !alreadyStarred };

        const ownSocket = userSockets[data.username];
        if (ownSocket && ownSocket !== socket.id) io.to(ownSocket).emit("messageStarUpdated", payload);
        socket.emit("messageStarUpdated", payload);

    }));

    socket.on("loadStarred", safe(socket, async (username) => {
        const db = getDB();
        const messages = await db.collection("messages")
            .find({ starredBy: username })
            .sort({ time: -1 })
            .toArray();
        socket.emit("starredMessages", messages);
    }));

    /* ---------- PIN (private + group) ---------- */

    socket.on("togglePin", safe(socket, async (data) => {

        // data: { id, sender, receiver, groupId?, pin }
        const db = getDB();

        await db.collection("messages").updateOne(
            { _id: new ObjectId(data.id) },
            { $set: { pinned: !!data.pin } }
        );

        const payload = { id: data.id, pinned: !!data.pin };

        if (data.groupId) {
            io.to(groupRoom(data.groupId)).emit("messagePinUpdated", payload);
        } else {
            [userSockets[data.sender], userSockets[data.receiver]].forEach(sid => {
                if (sid) io.to(sid).emit("messagePinUpdated", payload);
            });
        }

    }));

    socket.on("loadPinned", safe(socket, async (data) => {

        // data: { sender, receiver } for private, or { groupId } for group
        const db = getDB();

        const query = data.groupId
            ? { pinned: true, groupId: data.groupId }
            : {
                pinned: true,
                $or: [
                    { sender: data.sender, receiver: data.receiver },
                    { sender: data.receiver, receiver: data.sender }
                ]
            };

        const messages = await db.collection("messages").find(query).sort({ time: 1 }).toArray();
        socket.emit("pinnedMessages", messages);

    }));

    /* ---------- FORWARD (unchanged, private-only) ---------- */

    socket.on("forwardMessage", safe(socket, async (data) => {

        const db = getDB();

        for (const target of data.to) {

            const doc = {
                sender: data.from,
                receiver: target,
                delivered: false,
                seen: false,
                starredBy: [],
                pinned: false,
                forwarded: true,
                forwardedFrom: data.originalSender || data.from,
                time: new Date()
            };

            if (data.text) doc.text = data.text;
            if (data.image) doc.image = data.image;
            if (data.voice) doc.voice = data.voice;

            const result = await db.collection("messages").insertOne(doc);
            const targetSocket = userSockets[target];
            const eventName = data.image ? "imageMessage" : data.voice ? "voiceMessage" : "message";

            const outgoing = {
                id: result.insertedId.toString(),
                user: data.from,
                sender: data.from,
                receiver: target,
                text: data.text,
                image: data.image,
                voice: data.voice,
                forwarded: true,
                delivered: !!targetSocket,
                starredBy: [],
                pinned: false,
                time: doc.time
            };

            if (targetSocket) io.to(targetSocket).emit(eventName, outgoing);
            socket.emit(eventName, outgoing);

        }

    }));

    /* ---------- CONTACT LIST ---------- */

    socket.on("loadContacts", safe(socket, async (username) => {
        const contacts = await buildContacts(username);
        socket.emit("contactsList", contacts);
    }));

});

connectDB().then(() => {
    server.listen(3000, "0.0.0.0", () => {
        console.log("=================================");
        console.log("Server Running");
        console.log("http://localhost:3000");
        console.log("=================================");
    });
});
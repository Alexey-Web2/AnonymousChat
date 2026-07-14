require("dotenv").config(); // Переместили в самое начало для надежности

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const TelegramBot = require("node-telegram-bot-api");

// ======================
// ИНИЦИАЛИЗАЦИЯ SUPABASE
// ======================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY // <--- изменили название переменной тут
);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

const bot = new TelegramBot(
    process.env.TELEGRAM_BOT_TOKEN,
    { polling: true }
);

// ======================
// ДАННЫЕ ОНЛАЙН / ПОИСК
// ======================
let waitingUsers = [];
const activeRooms = {};
const ADMIN_USERNAME = "@ChatAdmin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ======================
// ТЕЛЕГРАМ БОТ
// ======================
bot.on("message", async (msg) => {
    const username = msg.from.username;
    if (!username) return;

    const appUsername = "@" + username;

    // Supabase Update
    await supabase
        .from('users')
        .update({ telegramChatId: msg.chat.id })
        .eq('username', appUsername);
});

// ======================
// SOCKET
// ======================
io.on("connection", (socket) => {

    console.log("Connected:", socket.id);
    socket.isAdmin = false;

    // ======================
    // LOGIN
    // ======================
    socket.on("login", async (username) => {
        try {
            // Ищем пользователя (maybeSingle возвращает null, если не найдено)
            let { data: user, error: findError } = await supabase
                .from('users')
                .select('*')
                .eq('username', username)
                .maybeSingle();

            if (findError) throw findError;

            // Если нет, создаем
            if (!user) {
                const { data: newUser, error: createError } = await supabase
                    .from('users')
                    .insert([{ username }])
                    .select()
                    .single();
                
                if (createError) throw createError;
                user = newUser;
            }

            if (user.banned) {
                socket.emit("banned");
                return;
            }

            socket.username = username;

            if (username === ADMIN_USERNAME) {
                socket.emit("needAdminPassword");
                return;
            }

            socket.emit("needCode");

        } catch (err) {
            console.error("Login Error:", err);
        }
    });

    socket.on("sendLoginCode", async () => {
        try {
            const { data: user } = await supabase
                .from('users')
                .select('*')
                .eq('username', socket.username)
                .maybeSingle();

            if (!user || !user.telegramChatId) {
                socket.emit("telegramNotLinked");
                return;
            }

            const code = Math.floor(100000 + Math.random() * 900000).toString();
            const expires = Date.now() + 5 * 60 * 1000;

            await supabase
                .from('users')
                .update({ loginCode: code, codeExpires: expires })
                .eq('id', user.id);

            await bot.sendMessage(
                user.telegramChatId,
                `Ваш код входа: ${code}`
            );

            socket.emit("codeSent");

        } catch (err) {
            console.error("Send Code Error:", err);
        }
    });

    socket.on("verifyLoginCode", async (code) => {
        try {
            const { data: user } = await supabase
                .from('users')
                .select('*')
                .eq('username', socket.username)
                .maybeSingle();

            if (!user) return;

            if (user.loginCode !== code) {
                socket.emit("wrongCode");
                return;
            }

            if (Date.now() > user.codeExpires) {
                socket.emit("wrongCode");
                return;
            }

            // Успешный вход: обновляем онлайн-статус
            await supabase
                .from('users')
                .update({ online: true, socketId: socket.id, loginCode: null })
                .eq('id', user.id);

            // Получаем старые личные сообщения
            const { data: messages } = await supabase
                .from('messages')
                .select('*')
                .eq('to', socket.username);

            socket.emit("messages", messages || []);
            socket.emit("loginSuccess");

        } catch (err) {
            console.error("Verify Code Error:", err);
        }
    });

    // ======================
    // ПОИСК СОБЕСЕДНИКА
    // ======================
    socket.on("findPartner", async (roomSize) => {
        const { data: settings } = await supabase
            .from('system_settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (settings && !settings.chatsEnabled) {
            socket.emit("chatsDisabled");
            return;
        }

        if (waitingUsers.find(u => u.id === socket.id)) return;

        waitingUsers.push({ socket, roomSize });

        const group = waitingUsers.filter(u => u.roomSize === roomSize);

        group.forEach(user => {
            user.socket.emit("searchCount", {
                found: group.length,
                total: roomSize
            });
        });

        if (group.length < roomSize) return;

        const roomUsers = waitingUsers
            .filter(u => u.roomSize === roomSize)
            .slice(0, roomSize);

        waitingUsers = waitingUsers.filter(u => !roomUsers.includes(u));

        const room = "room_" + Date.now();
        activeRooms[room] = { users: [] };

        roomUsers.forEach((user, index) => {
            user.socket.join(room);
            user.socket.room = room;
            user.socket.participantIndex = index + 1;
            activeRooms[room].users.push(user.socket.id);
        });

        io.to(room).emit("chatStarted", { roomSize });
    });

    // ======================
    // СООБЩЕНИЯ В ЧАТЕ
    // ======================
    socket.on("chatMessage", (text) => {
        if (!socket.room) return;
        socket.to(socket.room).emit("chatMessage", {
            text,
            participant: socket.participantIndex
        });
    });

    // ======================
    // ВЫХОД ИЗ ЧАТА
    // ======================
    socket.on("leaveChat", () => {
        if (!socket.room) return;
        const room = socket.room;
        io.to(room).emit("chatClosed");
        delete activeRooms[room];
    });

    // ======================
    // ЛИЧНЫЕ СООБЩЕНИЯ
    // ======================
    socket.on("sendPrivateMessage", async (data) => {
        const { data: settings } = await supabase
            .from('system_settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (settings && !settings.messagesEnabled) {
            socket.emit("messagesDisabled");
            return;
        }

        try {
            const { data: target } = await supabase
                .from('users')
                .select('*')
                .eq('username', data.to)
                .maybeSingle();

            if (!target) {
                socket.emit("userNotFound");
                return;
            }

            await supabase
                .from('messages')
                .insert([{
                    from: socket.username,
                    to: data.to,
                    text: data.text
                }]);

            if (target.online && target.socketId) {
                io.to(target.socketId).emit("newPrivateMessage", {
                    from: socket.username,
                    text: data.text
                });
            }

            socket.emit("privateSent");

        } catch (err) {
            console.error("Private Message Error:", err);
        }
    });

    // ======================
    // ПОДДЕРЖКА ПОЛЬЗОВАТЕЛЕМ
    // ======================
    socket.on("openSupport", async () => {
        try {
            let { data: conversation } = await supabase
                .from('support_conversations')
                .select('*')
                .eq('user', socket.username)
                .maybeSingle();

            if (!conversation) {
                const { data: newConv } = await supabase
                    .from('support_conversations')
                    .insert([{ user: socket.username }])
                    .select()
                    .single();
                conversation = newConv;
            }

            const { data: messages } = await supabase
                .from('support_messages')
                .select('*')
                .eq('conversationId', conversation.id);

            socket.emit("supportHistory", messages || []);

        } catch (err) {
            console.error("Open Support Error:", err);
        }
    });

    socket.on("supportMessage", async (text) => {
        const { data: settings } = await supabase
            .from('system_settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (settings && !settings.supportEnabled) {
            socket.emit("supportDisabled");
            return;
        }

        try {
            let { data: conversation } = await supabase
                .from('support_conversations')
                .select('*')
                .eq('user', socket.username)
                .maybeSingle();

            if (!conversation) {
                const { data: newConv } = await supabase
                    .from('support_conversations')
                    .insert([{ user: socket.username }])
                    .select()
                    .single();
                conversation = newConv;
            }

            await supabase
                .from('support_messages')
                .insert([{
                    conversationId: conversation.id,
                    sender: socket.username,
                    text
                }]);

            await supabase
                .from('support_conversations')
                .update({ unreadForAdmin: conversation.unreadForAdmin + 1 })
                .eq('id', conversation.id);

            const { data: admin } = await supabase
                .from('users')
                .select('*')
                .eq('username', ADMIN_USERNAME)
                .maybeSingle();

            if (admin && admin.online && admin.socketId) {
                io.to(admin.socketId).emit("newSupportMessage", {
                    sender: socket.username,
                    text
                });
            }

        } catch (err) {
            console.error("Support Msg Error:", err);
        }
    });

    // ======================
    // ПАНЕЛЬ АДМИНА
    // ======================
    socket.on("getSupportList", async () => {
        try {
            if (!socket.isAdmin) return;

            const { data: conversations } = await supabase
                .from('support_conversations')
                .select('*')
                .eq('active', true)
                .order('updated_at', { ascending: false });

            socket.emit("supportList", conversations || []);
        } catch (err) {
            console.error("Get Support List Error:", err);
        }
    });

    socket.on("openSupportConversation", async (user) => {
        try {
            if (!socket.isAdmin) return;

            const { data: conversation } = await supabase
                .from('support_conversations')
                .select('*')
                .eq('user', user)
                .maybeSingle();

            if (!conversation) return;

            const { data: messages } = await supabase
                .from('support_messages')
                .select('*')
                .eq('conversationId', conversation.id);

            await supabase
                .from('support_conversations')
                .update({ unreadForAdmin: 0 })
                .eq('id', conversation.id);

            socket.emit("supportConversation", {
                user,
                messages: messages || []
            });

        } catch (err) {
            console.error("Open Conv Error:", err);
        }
    });

    socket.on("adminSupportMessage", async (data) => {
        try {
            if (!socket.isAdmin) return;

            const { data: conversation } = await supabase
                .from('support_conversations')
                .select('*')
                .eq('user', data.user)
                .maybeSingle();

            if (!conversation) return;

            await supabase
                .from('support_messages')
                .insert([{
                    conversationId: conversation.id,
                    sender: ADMIN_USERNAME,
                    text: data.text
                }]);

            await supabase
                .from('support_conversations')
                .update({ unreadForUser: conversation.unreadForUser + 1 })
                .eq('id', conversation.id);

            const { data: target } = await supabase
                .from('users')
                .select('*')
                .eq('username', data.user)
                .maybeSingle();

            if (target && target.online && target.socketId) {
                io.to(target.socketId).emit("newSupportMessage", {
                    sender: ADMIN_USERNAME,
                    text: data.text
                });
            }

            socket.emit("adminMessageSent", { text: data.text });

        } catch (err) {
            console.error("Admin Support Msg Error:", err);
        }
    });

    socket.on("endSupportConversation", async (user) => {
        try {
            if (!socket.isAdmin) return;

            const { data: conversation } = await supabase
                .from('support_conversations')
                .select('*')
                .eq('user', user)
                .maybeSingle();

            if (!conversation) return;

            // Каскадное удаление (ON DELETE CASCADE) в Supabase удалит сообщения автоматически, 
            // но для надежности можно удалить явно или просто удалить диалог:
            await supabase
                .from('support_conversations')
                .delete()
                .eq('id', conversation.id);

            const { data: target } = await supabase
                .from('users')
                .select('*')
                .eq('username', user)
                .maybeSingle();

            if (target && target.online) {
                io.to(target.socketId).emit("supportEnded");
            }

            socket.emit("supportEndedAdmin", user);

        } catch (err) {
            console.error("End Support Error:", err);
        }
    });

    socket.on("getAllUsers", async () => {
        try {
            if (!socket.isAdmin) return;

            const { data: users } = await supabase
                .from('users')
                .select('*')
                .order('username', { ascending: true });

            socket.emit("allUsers", users || []);
        } catch (err) {
            console.error("Get All Users Error:", err);
        }
    });

    socket.on("toggleBanUser", async (username) => {
        try {
            if (!socket.isAdmin) return;

            const { data: user } = await supabase
                .from('users')
                .select('*')
                .eq('username', username)
                .maybeSingle();

            if (!user) return;

            const newBanStatus = !user.banned;

            await supabase
                .from('users')
                .update({ banned: newBanStatus })
                .eq('id', user.id);

            if (newBanStatus && user.socketId) {
                io.to(user.socketId).emit("banned");
            }

            const { data: users } = await supabase
                .from('users')
                .select('*')
                .order('username', { ascending: true });

            socket.emit("allUsers", users || []);

        } catch (err) {
            console.error("Toggle Ban Error:", err);
        }
    });

    socket.on("deleteUser", async (username) => {
        try {
            if (!socket.isAdmin) return;

            const { data: user } = await supabase
                .from('users')
                .select('*')
                .eq('username', username)
                .maybeSingle();

            if (!user) return;

            // Удаляем сообщения
            await supabase
                .from('messages')
                .delete()
                .or(`from.eq.${username},to.eq.${username}`);

            // Удаляем поддержку (сообщения удалятся каскадом)
            await supabase
                .from('support_conversations')
                .delete()
                .eq('user', username);

            if (user.socketId) {
                io.to(user.socketId).emit("accountDeleted");
            }

            await supabase
                .from('users')
                .delete()
                .eq('username', username);

            const { data: users } = await supabase
                .from('users')
                .select('*')
                .order('username', { ascending: true });

            socket.emit("allUsers", users || []);

        } catch (err) {
            console.error("Delete User Error:", err);
        }
    });

    socket.on("sendWarning", async (data) => {
        try {
            if (!socket.isAdmin) return;

            await supabase
                .from('messages')
                .insert([{
                    from: ADMIN_USERNAME,
                    to: data.user,
                    text: "⚠ Предупреждение: " + data.text,
                    warning: true
                }]);

            const { data: target } = await supabase
                .from('users')
                .select('*')
                .eq('username', data.user)
                .maybeSingle();

            if (target && target.online && target.socketId) {
                io.to(target.socketId).emit("newPrivateMessage", {
                    text: "⚠ Предупреждение: " + data.text,
                    warning: true
                });
            }

        } catch (err) {
            console.error("Send Warning Error:", err);
        }
    });

    socket.on("getAccessSettings", async () => {
        if (!socket.isAdmin) return;

        const { data: settings } = await supabase
            .from('system_settings')
            .select('*')
            .eq('id', 1)
            .single();

        socket.emit("accessSettings", settings);
    });

    socket.on("toggleSupport", async () => {
        if (!socket.isAdmin) return;
        
        const { data: settings } = await supabase.from('system_settings').select('*').eq('id', 1).single();
        const { data: updated } = await supabase.from('system_settings')
            .update({ supportEnabled: !settings.supportEnabled })
            .eq('id', 1).select().single();

        socket.emit("accessSettings", updated);
    });

    socket.on("toggleChats", async () => {
        if (!socket.isAdmin) return;

        const { data: settings } = await supabase.from('system_settings').select('*').eq('id', 1).single();
        const { data: updated } = await supabase.from('system_settings')
            .update({ chatsEnabled: !settings.chatsEnabled })
            .eq('id', 1).select().single();

        socket.emit("accessSettings", updated);
    });

    socket.on("toggleMessages", async () => {
        if (!socket.isAdmin) return;

        const { data: settings } = await supabase.from('system_settings').select('*').eq('id', 1).single();
        const { data: updated } = await supabase.from('system_settings')
            .update({ messagesEnabled: !settings.messagesEnabled })
            .eq('id', 1).select().single();

        socket.emit("accessSettings", updated);
    });

    socket.on("verifyAdminPassword", async (password) => {
        if (socket.username !== ADMIN_USERNAME) return;

        if (password !== ADMIN_PASSWORD) {
            socket.emit("wrongAdminPassword");
            return;
        }

        socket.isAdmin = true;

        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('username', ADMIN_USERNAME)
            .maybeSingle();

        if (user) {
            await supabase
                .from('users')
                .update({ online: true, socketId: socket.id })
                .eq('id', user.id);
        }

        socket.emit("adminLogged");
        socket.emit("loginSuccess");
    });

    // ======================
    // DISCONNECT
    // ======================
    socket.on("disconnect", async () => {
        console.log("Disconnected:", socket.id);

        if (socket.username) {
            await supabase
                .from('users')
                .update({ online: false })
                .eq('username', socket.username);
        }

        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

        if (socket.room) {
            io.to(socket.room).emit("chatClosed");
            delete activeRooms[socket.room];
        }
    });

});

// ======================
// START
// ======================
server.listen(process.env.PORT || 3000, () => {
    console.log("Server started on Supabase!");
});
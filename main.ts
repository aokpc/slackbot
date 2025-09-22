import * as SlackAPI from "npm:@slack/web-api@6.13.0"

const TOKEN_APP = Deno.env.get("TOKEN")
const ADMIN = null
const app = new SlackAPI.WebClient(TOKEN_APP)
const slack = new EventTarget()

type slackEvent = {
    type: string;
    [key: string]: any;
}

type slackMessage = {
    user: string;
    text: string;
    ts: string;
    replies?: slackMessage[]
}
type slackUser = {
    user: string;
    img: string;
    name: string;
}
type slackHistory = {
    users: Record<string, slackUser>,
    messages: slackMessage[],
    channel: string,
}


class SlackEvent extends Event {
    constructor(public data: slackEvent, public resolve: (value: Response) => void) {
        super(data.type)
    }
}

slack.addEventListener("url_verification", (data) => {
    const event = data as SlackEvent
    event.resolve(new Response(event.data.challenge))
})
slack.addEventListener("event_callback", async (data) => {
    const event = data as SlackEvent
    if (event.data.event.type === "message" && (!ADMIN || (ADMIN && event.data.event.user === ADMIN))) {
        if (event.data.event.text === "771:?") {
            const channel = event.data.event.channel
            await sendTxt(channel, "ok")
        }
    }
})

// スラッシュコマンド用のイベントリスナー
slack.addEventListener("slash_command", async (data) => {
    const event = data as SlackEvent
    event.resolve(new Response("アーカイブを開始しています...", {
        headers: { "content-type": "text/plain" }
    }))

    const channel = event.data.channel_id
    const user = event.data.user_id

    // 管理者チェック
    if (ADMIN && user !== ADMIN) {
        await sendTxt(channel, "このコマンドを実行する権限がありません。")
        return
    }

    try {
        const res = await app.conversations.info({ channel })
        const name = res.channel!.name

        const body = new TextEncoder().encode(JSON.stringify(await archive(channel), null, 1))
        const upload = await app.files.getUploadURLExternal({
            filename: `messageArchive-${name!}.json`,
            length: body.length
        });

        await fetch(upload.upload_url!, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body
        })

        await app.files.completeUploadExternal({
            files: [{
                id: upload.file_id!,
                title: `messageArchive-${name!}.json`
            }],
            channel_id: channel
        })
    } catch (error) {
        console.error("Archive error:", error)
        await sendTxt(channel, "アーカイブ中にエラーが発生しました。")
    }
})

async function history(params: SlackAPI.ConversationsHistoryArguments): Promise<SlackAPI.ConversationsHistoryResponse> {
    return await (await fetch("https://slack.com/api/conversations.history", { body: JSON.stringify(params), method: "POST", headers: { Authorization: "Bearer " + TOKEN_APP, "Content-Type": "application/json" } })).json()
}

async function archive(channel: string): Promise<slackHistory> {
    const users: Record<string, slackUser> = {}
    const historys: slackMessage[] = []
    let cursor: string | undefined;
    while (true) {
        const res = await history({ channel, cursor, limit: 500 })
        for (const message of res.messages!) {
            if (message.text || message.files) {
                let text = message.text || ""
                if (!users[message.user!]) {
                    try {
                        const res = await app.users.info({ user: message.user! })
                        users[message.user!] = {
                            user: res.user!.id!,
                            img: res.user!.profile!.image_72!,
                            name: res.user!.profile!.display_name! || res.user!.real_name!,
                        }
                    } catch (_) {
                        users[message.user!] = {
                            user: message.user!,
                            img: message.user!,
                            name: "NotFound_" + message.user!,
                        }
                    }
                }
                if (message.files) {
                    message.files.forEach(e => {
                        if (e.name) {
                            text += `\n<ファイルを送信しました:${e.name}>`
                        }
                    })
                }
                const replies: slackMessage[] = []
                if (message.reply_count) {
                    const rpres = await app.conversations
                        .replies({
                            channel,
                            ts: message.ts!,
                            limit: 500,
                        })
                    for (const message of rpres.messages!.slice(1)) {
                        if (message.text || message.files) {
                            let text = message.text || ""
                            if (!users[message.user!]) {
                                const res = await app.users.info({ user: message.user! })
                                users[message.user!] = {
                                    user: res.user!.id!,
                                    img: res.user!.profile!.image_72!,
                                    name: res.user!.profile!.display_name! || res.user!.real_name!,
                                }
                            }
                            if (message.files) {
                                message.files.forEach(e => {
                                    if (e.name) {
                                        text += `\n<ファイルを送信しました:${e.name}>`
                                    }
                                })
                            }
                            if (text) {
                                replies.push({ user: message.user!, text, ts: message.ts! })
                            }
                        }
                    }
                }
                historys.push({ user: message.user!, text, ts: message.ts!, replies })
            }
        }
        cursor = res.response_metadata?.next_cursor
        if (!cursor) {
            break
        }
    }
    return { messages: historys, users, channel }
}

function sendTxt(channel: string, text: string) {
    return app.chat.postMessage({ channel, text })
}

async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/event" && request.method === "POST") {
        const data = (await request.json()) as slackEvent
        console.log(data)
        const { promise, resolve } = Promise.withResolvers<Response>()
        const event = new SlackEvent(data, resolve)
        slack.dispatchEvent(event)
        setTimeout(() => {
            event.resolve(new Response(""))
        }, 2000)
        return promise
    } else if (url.pathname === "/slack/command" && request.method === "POST") {
        // スラッシュコマンドのハンドリング
        const formData = await request.formData()
        const slashCommandData = {
            type: "slash_command",
            command: formData.get("command"),
            text: formData.get("text"),
            channel_id: formData.get("channel_id"),
            user_id: formData.get("user_id"),
            team_id: formData.get("team_id")
        }
        console.log("Slash command:", slashCommandData)
        const { promise, resolve } = Promise.withResolvers<Response>()
        const event = new SlackEvent(slashCommandData, resolve)
        slack.dispatchEvent(event)
        setTimeout(() => {
            event.resolve(new Response("コマンドの処理がタイムアウトしました"))
        }, 5000)
        return promise
    } else if (url.pathname === "/") {
        return new Response(await Deno.readTextFile("./index.html"), { headers: { "content-type": "text/html" } })
    }
    return new Response("ok")
}

Deno.serve(handler)

/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
    appenders: {
        vcr: {
            type: "recording"
        },
        out: {
            type: "console"
        }
    },
    categories: { default: { appenders: ["vcr", "out"], level: "info" } }
});

const logger = log4js.getLogger();
// process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
    const index = result.length;
    if (res.errorCode === "User_Not_Chance") {
        result.push(`第${index}次抽奖失败,次数不足`);
    } else {
        result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
    }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 任务 1.签到 2.天天抽红包 3.自动备份抽红包
const doTask = async (cloudClient) => {
    const result = [];
    const res1 = await cloudClient.userSign();
    result.push(
        `${res1.isSign? "已经签到过了，" : ""}签到获得${res1.netdiskBonus}M空间`
    );
    // 这里返回签到获得的空间值
    return { result, personalSignSpace: res1.netdiskBonus };
};

const doFamilyTask = async (cloudClient) => {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    const result = [];
    if (familyInfoResp && familyInfoResp.length > 0) {
        const firstFamily = familyInfoResp[0];
        const { familyId } = firstFamily;
        const res = await cloudClient.familyUserSign(familyId);
        result.push(
            "家庭任务" +
            `${res.signStatus? "已经签到过了，" : ""}签到获得${
                res.bonusSpace
            }M空间`
        );
    }
    return result;
};

const pushServerChan = (title, desp) => {
    if (!serverChan.sendKey) {
        return;
    }
    const data = {
        title,
        desp
    };
    superagent
    .post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
    .type("form")
    .send(data)
    .end((err, res) => {
            if (err) {
                logger.error(`ServerChan推送失败:${JSON.stringify(err)}`);
                return;
            }
            const json = JSON.parse(res.text);
            if (json.code!== 0) {
                logger.error(`ServerChan推送失败:${JSON.stringify(json)}`);
            } else {
                logger.info("ServerChan推送成功");
            }
        });
};

const pushTelegramBot = (title, desp) => {
    if (!(telegramBot.botToken && telegramBot.chatId)) {
        return;
    }
    const data = {
        chat_id: telegramBot.chatId,
        text: `${title}\n\n${desp}`
    };
    superagent
    .post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
    .type("form")
    .send(data)
    .end((err, res) => {
            if (err) {
                logger.error(`TelegramBot推送失败:${JSON.stringify(err)}`);
                return;
            }
            const json = JSON.parse(res.text);
            if (!json.ok) {
                logger.error(`TelegramBot推送失败:${JSON.stringify(json)}`);
            } else {
                logger.info("TelegramBot推送成功");
            }
        });
};

const pushWecomBot = (title, desp) => {
    if (!(wecomBot.key && wecomBot.telphone)) {
        return;
    }
    const data = {
        msgtype: "text",
        text: {
            content: `${title}\n\n${desp}`,
            mentioned_mobile_list: [wecomBot.telphone]
        }
    };
    superagent
    .post(
            `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`
        )
    .send(data)
    .end((err, res) => {
            if (err) {
                logger.error(`wecomBot推送失败:${JSON.stringify(err)}`);
                return;
            }
            const json = JSON.parse(res.text);
            if (json.errcode) {
                logger.error(`wecomBot推送失败:${JSON.stringify(json)}`);
            } else {
                logger.info("wecomBot推送成功");
            }
        });
};

const pushWxPusher = (title, desp) => {
    if (!(wxpush.appToken && wxpush.uid)) {
        return;
    }
    const data = {
        appToken: wxpush.appToken,
        contentType: 1,
        summary: title,
        content: desp,
        uids: [wxpush.uid]
    };
    superagent
    .post("https://wxpusher.zjiecode.com/api/send/message")
    .send(data)
    .end((err, res) => {
            if (err) {
                logger.error(`wxPusher推送失败:${JSON.stringify(err)}`);
                return;
            }
            const json = JSON.parse(res.text);
            if (json.data[0].code!== 1000) {
                logger.error(`wxPusher推送失败:${JSON.stringify(json)}`);
            } else {
                logger.info("wxPusher推送成功");
            }
        });
};

const push = (title, desp) => {
    pushServerChan(title, desp);
    pushTelegramBot(title, desp);
    pushWecomBot(title, desp);
    pushWxPusher(title, desp);
};

// 开始执行程序
async function main() {
    let totalFamilyBonus = 0;
    let lastAccountInfo;
    for (let index = 0; index < accounts.length; index += 1) {
        const account = accounts[index];
        const { userName, password } = account;
        if (userName && password) {
            const userNameInfo = mask(userName, 3, 7);
            try {
                const cloudClient = new CloudClient(userName, password);
                await cloudClient.login();
                const { personalSignSpace } = await doTask(cloudClient);
                const familyResult = await doFamilyTask(cloudClient);
                let familyBonus = 0;
                if (familyResult.length > 0) {
                    familyBonus = parseInt(familyResult[0].match(/(\d+)M/)[1]);
                    totalFamilyBonus += familyBonus;
                }
                const personalBonus = personalSignSpace;
                logger.log(`🆔 ${userNameInfo}  个人签到${personalBonus}MB，家庭签到${familyBonus}MB`);
                const { cloudCapacityInfo, familyCapacityInfo } =
                    await cloudClient.getUserSizeInfo();

                // 记录最后一个账号的信息
                lastAccountInfo = {
                    userNameInfo,
                    personalSpace: cloudCapacityInfo.totalSize / 1024 / 1024 / 1024,
                    familySpace: familyCapacityInfo.totalSize / 1024 / 1024 / 1024,
                    // 新增个人签到空间值
                    todayPersonalSign: personalSignSpace
                };
            } catch (e) {
                logger.error(e);
                if (e.code === "ETIMEDOUT") {
                    throw e;
                }
            }
        }
    }


    // 显示最后一个账号的信息
    if (lastAccountInfo) {
        logger.log(`\n`);
        logger.log(`══════════容量汇总══════════\n`);
        logger.log(`╔════════════════════╗`);
        logger.log(`║ 天 翼 账 户 ║ 个 人 空 间 ║ 家 庭 空 间 ║`);
        logger.log(`╠════════════════════╣`);
        logger.log(`║ ${lastAccountInfo.userNameInfo} ║ ${lastAccountInfo.personalSpace.toFixed(2)}G ║ ${lastAccountInfo.familySpace.toFixed(2)}G ║ `);
        logger.log(`╚════════════════════╝`);
        logger.log(`📊今日获得容量： 个人空间：${lastAccountInfo.todayPersonalSign}M 家庭空间：${totalFamilyBonus}M`);
    }
}

(async () => {
    try {
        await main();
    } finally {
        const events = recording.replay();
        const content = events.map((e) => `${e.data.join("")}`).join("  \n");
        push("天翼云盘自动签到任务", content);
        recording.erase();
    }
})();

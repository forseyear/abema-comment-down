const request = require("request-promise");
const clipboardy = require("clipboardy");
const xml2js = require("xml2js");
const fs = require("fs");

const config = {
  token: "",
  waitMilliSecond: 1
};

const sleep = sec => {
  return new Promise((resolve, reject) => setTimeout(resolve, sec * 1000));
};

const getSchedule = async (channel, yyyymmdd) => {
  return await request({
    uri: `https://api.abema.io/v1/media?channelIds=${channel}&dateFrom=${yyyymmdd}`,
    method: "GET",
    headers: {
      "Authorization": `bearer ${config.token}`
    }
  }).catch(error => {
    throw error;
  });
};

const getComments = async (slotId, date) => {
  return await request({
    uri: `https://api.abema.io/v1/slots/${slotId}/comments?limit=1000&until=${date}`,
    method: "GET",
    headers: {
      "Authorization": `bearer ${config.token}`
    }
  }).catch(async error => {
    // 502 エラーの場合、リトライする
    if (error.statusCode === 502) {
      return await getComments(slotId, date);
    }
    throw error;
  });
};

const escapeXml = str => {
  return str
    .replace(/\&/g, "&amp;")
    .replace(/\</g, "&lt;")
    .replace(/\>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/\'/g, "&#39;")
    .replace(/\0/g, "&#x0;");
};

const download = async slotId => {
  // ルートノードの名前
  const packet = {
    // 取得したコメントオブジェクトが入ってくる配列
    rawComments: [],
    // 取得したコメントの中で一番古いコメントを格納。 vpos の計算に使う
    rawOldComment: null,
    // xml 出力用に整形されたオブジェクトを入れる配列
    chat: []
  };

  // 取得が終わるまで抜けられないループ
  while (true) {
    // 最後のコメントから時刻を取ってくる。ないときは現在時刻から。
    const lastComment = packet.rawComments[packet.rawComments.length - 1] || { createdAtMs: +new Date() };
    const date = lastComment.createdAtMs;

    // AbemaTV からコメントを取得し、オブジェクトにする
    const comments = JSON.parse(await getComments(slotId, date)).comments;

    if (comments === null) {
      // 最初から0コメントだった場合、ログを出力しループを抜ける
      if (packet.rawComments.length === 0) {
        console.log(`${slotId} はコメントが存在しませんでした。`);
        return;
      }
      // 正常に取得が終わったので、ループを抜ける。前回 -1 した createdAtMs を戻す
      // このコードのほうが上にあるのは、comments が null のときに length を読み取ろうとするのを防ぐため
      packet.rawComments[packet.rawComments.length - 1].createdAtMs += 1;
      break;
    }

    if (comments.length === 1) {
      // 最も古いコメントの時刻から vpos の計算もするのでここで別の変数にも入れておく
      packet.rawOldComment = comments[0];
      // 取得したコメントが 1 件しかないとき、無限に取得するのを防ぐために createdAtMs を -1 する
      // 普段のコメントで行わないのは、 millsecound まで同じ複数のコメントを取得漏れさせないように
      // 2 以上のコメントを取得するときも、前回の最終コメントと最新コメントが重複する
      comments[0].createdAtMs -= 1;
    }

    // コメントを追加する
    packet.rawComments = packet.rawComments.concat(comments);

    // 鯖負荷対策の処理待ち
    await sleep(config.waitMilliSecond);
  }

  for (const comment of packet.rawComments) {
    packet.chat.push({
      $: {
        // ミリ秒から秒単位に変換
        date: Math.floor(comment.createdAtMs / 1000),
        user_id: comment.userId,
        id: comment.id,
        // 100 分の 1 秒までの経過秒数
        vpos: Math.floor((comment.createdAtMs - packet.rawOldComment.createdAtMs) / 10),
        createdAtMs: comment.createdAtMs
      },
      _: escapeXml(comment.message)
    });
  }
  // このままでは最終コメントからとなるので、逆順にする
  packet.chat.reverse();

  const builder = new xml2js.Builder({
    rootName: "packet"
  });
  const rawXml = builder.buildObject({
    chat: packet.chat
  });

  // コメントの取得処理より、重複部分があるのでここで削除する
  const xmlComments = rawXml.split("\n").filter((comment, index, self) => self.indexOf(comment) === index);

  // 改行コードや namespace を他のソフトに合わせる
  const resultXml = xmlComments.join("\r\n");
  const xml = resultXml.replace(" standalone=\"yes\"", "");

  fs.writeFile(`dist/${slotId}.xml`, xml, error => {
    if (error) {
      throw error;
      return;
    }
    console.log(`${slotId} の保存をしました。合計${xmlComments.length}ｺﾒ`);
  });
};

(async () => {
  const clipboard = await clipboardy.read();
  let slotIds;

  try {
    slotIds = JSON.parse(`${clipboard}`);
  }
  catch (error) {
    slotIds = undefined;
  }

  if (typeof slotIds !== "object") {
    throw new Error(`Invalid Clipboard Text; Text must be stringArray.\nex: "["slotId", "slotId", "slotId", ...]"\n`);
    return;
  }

  for (const slotId of slotIds) {
    await download(slotId);
    await sleep(0.001);
  }
})();

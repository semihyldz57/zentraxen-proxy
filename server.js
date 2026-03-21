import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_TOKEN = process.env.ZENTRAXEN_AI_CLIENT_TOKEN;

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Zentraxen J.A.R.V.I.S. Secure Proxy" });
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const incomingToken = req.header("X-Zentraxen-Client");

    // Güvenlik Kontrolü: Uygulamadan gelen şifre, bizim belirlediğimiz şifreyle eşleşiyor mu?
    if (!CLIENT_TOKEN || incomingToken !== CLIENT_TOKEN) {
      return res.status(401).json({ error: { message: "Yetkisiz Erişim! Geçersiz Token." } });
    }

    const { model, messages, temperature, max_tokens } = req.body;

    // OpenAI'a İsteği Gönder (Gerçek API Key sadece burada kullanılıyor)
    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });

    const data = await openAiResponse.json();
    return res.status(openAiResponse.status).json(data);

  } catch (error) {
    console.error("Proxy Hatası:", error);
    return res.status(500).json({ error: { message: "Sunucu bağlantı hatası." } });
  }
});

app.listen(PORT, () => {
  console.log(`Zentraxen Karargahı Aktif. Port: ${PORT}`);
});
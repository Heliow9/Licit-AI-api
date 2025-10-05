(async () => {
  const { MongoClient } = require("mongodb");

  const uri    = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "licit_ai";
  if (!uri)    throw new Error("Defina MONGODB_URI");
  if (!dbName) throw new Error("Defina MONGODB_DB");

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  // ===== CONFIGURE AQUI =====
  const companyName = "REAL ENERGY LTDA";
  const cnpjRaw     = "41.116.138/0001-38";
  const ownerEmail  = "helio@realenergy.com.br";
  const ownerName   = "Helio Livramento";
  // hash bcrypt de "SenhaForte!123"
  const passwordHash= "$2b$10$qzAzsOg4yT..bm1.YUJy0uM7g8u7aEUB2KSB/zyl3WEMCpSyTMpxi";
  // ==========================

  const now  = new Date();
  const cnpj = cnpjRaw.replace(/\D/g, "");

  // 0) tenta reaproveitar empresa existente pelo CNPJ
  let company = await db.collection("companies").findOne({ cnpj });
  if (!company) {
    // 1) cria empresa
    const companyDoc = {
      name: companyName,
      cnpj,
      contact: { email: "contato@realenergy.com.br", phone: "(81) 99999-9999" },
      address: { street: "Rua X, 123", city: "Recife", state: "PE", zip: "50000-000" },
      plan: "free",
      createdBy: null,
      createdAt: now,
      updatedAt: now
    };
    const cRes = await db.collection("companies").insertOne(companyDoc);
    company = { _id: cRes.insertedId, ...companyDoc };
  }

  // 2) upsert do usuário como owner (sem status em $setOnInsert!)
  const email = ownerEmail.toLowerCase().trim();
  await db.collection("users").updateOne(
    { email },
    {
      $setOnInsert: {
        passwordHash,
        name: ownerName,
        // status REMOVIDO daqui para evitar conflito
        settings: { locale: "pt-BR", theme: "light", notifications: true },
        createdAt: now
      },
      $set: {
        role: "owner",
        companyId: company._id,
        status: "active",
        updatedAt: now
      }
    },
    { upsert: true }
  );

  const owner = await db.collection("users").findOne({ email });

  // 3) amarra createdBy na empresa (idempotente)
  await db.collection("companies").updateOne(
    { _id: company._id },
    { $set: { createdBy: owner._id, updatedAt: new Date() } }
  );

  console.log(" companyId=" + company._id.toString());
  console.log(" ownerId=" + owner._id.toString());

  await client.close();
})().catch(e => { console.error("Seed error:", e); process.exit(1); });

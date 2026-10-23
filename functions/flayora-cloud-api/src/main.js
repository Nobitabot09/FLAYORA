import { Client, TablesDB, Storage, Query, ID } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { createHash } from "node:crypto";

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY);

const tables = new TablesDB(client);
const storage = new Storage(client);

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID = process.env.APPWRITE_SITE_DATA_TABLE_ID;
const BUCKET_ID = process.env.APPWRITE_IMAGE_BUCKET_ID || "flayora-images";
const ALLOWED_ORIGIN = "https://nobitabot09.github.io";
const MAX_ROW_VALUE = 4500;
const MAX_VALUE_LENGTH = 3000000;
const CHUNK_MARKER = "__flayoraChunks";

export default async ({ req, res, log, error }) => {
  const origin = req.headers.origin || "";
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Flayora-Pin",
    "Vary": "Origin"
  };

  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.json({ error: "Origin not allowed" }, 403, headers);
  }
  if (req.method === "OPTIONS") return res.text("", 204, headers);

  try {
    if (!(process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY) ||
        !process.env.APPWRITE_PROJECT_ID || !process.env.APPWRITE_ENDPOINT ||
        !DATABASE_ID || !TABLE_ID || !process.env.FLAYORA_TEAM_PIN) {
      error("Required Function environment variables are missing.");
      return res.json({ error: "Server configuration incomplete" }, 500, headers);
    }

    const body = req.bodyJson || {};
    const action = body.action;
    const key = typeof body.key === "string" ? body.key : "";
    if (action !== "list" && (key.length < 1 || key.length > 255)) {
      return res.json({ error: "Invalid key" }, 400, headers);
    }

    if (["set", "delete"].includes(action)) {
      const supplied = req.headers["x-flayora-pin"] || "";
      const expected = process.env.FLAYORA_TEAM_PIN;
      if (supplied.length !== expected.length || supplied !== expected) {
        return res.json({ error: "Unauthorized" }, 401, headers);
      }
    }

    const findRows = async (searchKey) => {
      const result = await tables.listRows({
        databaseId: DATABASE_ID, tableId: TABLE_ID,
        queries: [Query.equal("key", searchKey)], total: false, limit: 1
      });
      return result.rows || [];
    };

    const putRow = async (rowKey, value) => {
      const rows = await findRows(rowKey);
      if (rows.length) {
        await tables.updateRow({
          databaseId: DATABASE_ID, tableId: TABLE_ID,
          rowId: rows[0].$id, data: { value }
        });
      } else {
        await tables.createRow({
          databaseId: DATABASE_ID, tableId: TABLE_ID,
          rowId: ID.unique(), data: { key: rowKey, value }
        });
      }
    };

    const removeRow = async (rowKey) => {
      const rows = await findRows(rowKey);
      if (rows.length) {
        await tables.deleteRow({
          databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: rows[0].$id
        });
      }
    };

    const listRows = async () => {
      const all = [];
      let offset = 0;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const result = await tables.listRows({
          databaseId: DATABASE_ID, tableId: TABLE_ID,
          total: false, limit: 500, offset
        });
        const page = result.rows || [];
        all.push(...page);
        if (page.length < 500) break;
        offset += page.length;
      }
      return all;
    };

    const getImageFileId = (imageKey) =>
      createHash("sha256").update(imageKey).digest("hex").slice(0, 32);

    // Temporary, fixed-key deployment diagnostic. It cannot read or modify catalogue records.
    if (action === "probe" && key === "__flayora-probe__") {
      const probeValue = "P".repeat(9000);
      const pieces = [];
      for (let i = 0; i < probeValue.length; i += MAX_ROW_VALUE) {
        pieces.push(probeValue.slice(i, i + MAX_ROW_VALUE));
      }
      for (let i = 0; i < pieces.length; i++) {
        await putRow(key + ":__chunk:" + i, pieces[i]);
      }
      await putRow(key, JSON.stringify({ [CHUNK_MARKER]: pieces.length }));
      const markerRows = await findRows(key);
      const marker = markerRows.length ? JSON.parse(markerRows[0].value) : {};
      const readPieces = await Promise.all(Array.from(
        { length: marker[CHUNK_MARKER] || 0 },
        (_, i) => findRows(key + ":__chunk:" + i)
      ));
      const reconstructed = readPieces.map(rows => rows[0]?.value || "").join("");
      const tableVerified = reconstructed === probeValue;

      let storageVerified = false;
      const fileId = "flayora-probe-file";
      try {
        await storage.createFile({
          bucketId: BUCKET_ID,
          fileId,
          file: InputFile.fromBuffer(Buffer.from("Flayora storage diagnostic"), "flayora-probe.txt", "text/plain")
        });
        const file = await storage.getFile({ bucketId: BUCKET_ID, fileId });
        storageVerified = file.$id === fileId;
      } finally {
        try { await storage.deleteFile({ bucketId: BUCKET_ID, fileId }); } catch (_) {}
      }

      const cleanupRows = (await listRows()).filter(row =>
        row.key === key || (typeof row.key === "string" && row.key.startsWith(key + ":__chunk:"))
      );
      await Promise.all(cleanupRows.map(row => tables.deleteRow({
        databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: row.$id
      })));
      return res.json({
        ok: tableVerified && storageVerified,
        tableWriteReadChunkDelete: tableVerified,
        bucketCreateReadDelete: storageVerified
      }, tableVerified && storageVerified ? 200 : 500, headers);
    }

    if (action === "list") {
      const prefix = typeof body.prefix === "string" ? body.prefix : "";
      const rows = await listRows();
      return res.json({
        keys: rows.map(row => row.key).filter(k =>
          typeof k === "string" && k.startsWith(prefix) && !k.includes(":__chunk:")
        ),
        prefix
      }, 200, headers);
    }

    if (action === "get") {
      const rows = await findRows(key);
      if (!rows.length) return res.json({ value: null }, 200, headers);
      let value = rows[0].value ?? null;
      if (typeof value === "string" && value.length < 100 &&
          value.startsWith("{")) {
        try {
          const marker = JSON.parse(value);
          if (Number.isInteger(marker[CHUNK_MARKER]) && marker[CHUNK_MARKER] >= 1) {
            const parts = await Promise.all(Array.from(
              { length: marker[CHUNK_MARKER] },
              (_, i) => findRows(key + ":__chunk:" + i)
            ));
            if (parts.some(rowsForPart => !rowsForPart.length)) {
              throw new Error("Catalogue data is missing a cloud chunk.");
            }
            value = parts.map(rowsForPart => rowsForPart[0].value || "").join("");
          }
        } catch (e) {
          if (String(e?.message || "").includes("missing a cloud chunk")) throw e;
        }
      }
      return res.json({ key, value, shared: true, storageMode: "cloud" }, 200, headers);
    }

    if (action === "set") {
      if (typeof body.value !== "string" || body.value.length > MAX_VALUE_LENGTH) {
        return res.json({ error: "Value must be a string within the 3 MB limit" }, 413, headers);
      }

      if (key.startsWith("flayora-image:")) {
        const match = body.value.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return res.json({ error: "Product image must be a JPG or PNG data URL" }, 400, headers);
        const mimeType = match[1];
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length > 2 * 1024 * 1024) {
          return res.json({ error: "Image exceeds the 2 MB upload limit" }, 413, headers);
        }
        const fileId = getImageFileId(key);
        const ext = mimeType === "image/png" ? "png" : "jpg";
        try {
          await storage.getFile({ bucketId: BUCKET_ID, fileId });
          await storage.deleteFile({ bucketId: BUCKET_ID, fileId });
        } catch (_) {}
        await storage.createFile({
          bucketId: BUCKET_ID,
          fileId,
          file: InputFile.fromBuffer(bytes, "flayora-" + fileId + "." + ext, mimeType)
        });
        const imageUrl = process.env.APPWRITE_ENDPOINT + "/storage/buckets/" +
          encodeURIComponent(BUCKET_ID) + "/files/" + encodeURIComponent(fileId) +
          "/view?project=" + encodeURIComponent(process.env.APPWRITE_PROJECT_ID);
        await putRow(key, imageUrl);
        return res.json({ ok: true, key, value: imageUrl, shared: true, storageMode: "cloud" }, 200, headers);
      }

      const allRows = await listRows();
      const oldChunks = allRows.filter(row =>
        typeof row.key === "string" && row.key.startsWith(key + ":__chunk:")
      );
      await Promise.all(oldChunks.map(row => tables.deleteRow({
        databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: row.$id
      })));

      if (body.value.length <= MAX_ROW_VALUE) {
        await putRow(key, body.value);
      } else {
        const chunks = [];
        for (let i = 0; i < body.value.length; i += MAX_ROW_VALUE) {
          chunks.push(body.value.slice(i, i + MAX_ROW_VALUE));
        }
        await Promise.all(chunks.map((part, i) => putRow(key + ":__chunk:" + i, part)));
        await putRow(key, JSON.stringify({ [CHUNK_MARKER]: chunks.length }));
      }
      return res.json({ ok: true, key, shared: true, storageMode: "cloud" }, 200, headers);
    }

    if (action === "delete") {
      if (key.startsWith("flayora-image:")) {
        const fileId = getImageFileId(key);
        try { await storage.deleteFile({ bucketId: BUCKET_ID, fileId }); } catch (_) {}
      }
      const allRows = await listRows();
      const matching = allRows.filter(row =>
        row.key === key || (typeof row.key === "string" && row.key.startsWith(key + ":__chunk:"))
      );
      await Promise.all(matching.map(row => tables.deleteRow({
        databaseId: DATABASE_ID, tableId: TABLE_ID, rowId: row.$id
      })));
      return res.json({ ok: true, key, shared: true, storageMode: "cloud" }, 200, headers);
    }

    return res.json({ error: "Unsupported action" }, 400, headers);
  } catch (e) {
    log("Cloud operation failed: " + String(e));
    log("Cause: " + String(e?.cause?.message || e?.cause || "No underlying cause provided"));
    return res.json({ error: "Cloud operation failed" }, 500, headers);
  }
};

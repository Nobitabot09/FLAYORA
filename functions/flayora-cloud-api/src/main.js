
import { Client, TablesDB, Query, ID } from "node-appwrite";

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const tables = new TablesDB(client);

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const TABLE_ID = process.env.APPWRITE_SITE_DATA_TABLE_ID;
const ALLOWED_ORIGIN = "https://nobitabot09.github.io";
const MAX_VALUE_LENGTH = 4000;

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

  if (req.method === "OPTIONS") {
    return res.text("", 204, headers);
  }

  try {
    if (!process.env.APPWRITE_API_KEY ||
        !process.env.APPWRITE_PROJECT_ID ||
        !process.env.APPWRITE_ENDPOINT ||
        !DATABASE_ID ||
        !TABLE_ID ||
        !process.env.FLAYORA_TEAM_PIN) {
      error("Required Function environment variables are missing.");
      return res.json({ error: "Server configuration incomplete" }, 500, headers);
    }

    const body = req.bodyJson || {};
    const action = body.action;
    const key = typeof body.key === "string" ? body.key : "";

    if (key.length < 1 || key.length > 255) {
      return res.json({ error: "Invalid key" }, 400, headers);
    }

    const writeActions = ["set", "delete"];
    if (writeActions.includes(action)) {
      const supplied = req.headers["x-flayora-pin"] || "";
      const expected = process.env.FLAYORA_TEAM_PIN;

      if (supplied.length !== expected.length || supplied !== expected) {
        return res.json({ error: "Unauthorized" }, 401, headers);
      }
    }

    const findRows = async () => {
      const result = await tables.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_ID,
        queries: [Query.equal("key", key)],
        total: false,
        limit: 1
      });
      return result.rows || [];
    };

    if (action === "get") {
      const rows = await findRows();
      return res.json({
        value: rows.length ? rows[0].value : null
      }, 200, headers);
    }

    if (action === "set") {
      if (typeof body.value !== "string" ||
          body.value.length > MAX_VALUE_LENGTH) {
        return res.json({
          error: "Value must be a string of at most 4000 characters"
        }, 413, headers);
      }

      const rows = await findRows();
      if (rows.length) {
        await tables.updateRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_ID,
          rowId: rows[0].$id,
          data: { value: body.value }
        });
      } else {
        await tables.createRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_ID,
          rowId: ID.unique(),
          data: { key, value: body.value }
        });
      }

      return res.json({ ok: true }, 200, headers);
    }

    if (action === "delete") {
      const rows = await findRows();
      if (rows.length) {
        await tables.deleteRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_ID,
          rowId: rows[0].$id
        });
      }
      return res.json({ ok: true }, 200, headers);
    }

    return res.json({ error: "Unsupported action" }, 400, headers);
  } catch (e) {
    error(String(e));
    return res.json({ error: "Cloud operation failed" }, 500, headers);
  }
};

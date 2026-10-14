// SINH TỰ ĐỘNG bởi `npm run catalog:build` từ libs/providers/src/catalog/entries/*.json — KHÔNG sửa tay.
// Test [PK:T19] đỏ khi file này lệch với entries/ (quên build lại).
import type { CatalogEntry } from './types';

export const CATALOG_DATA: CatalogEntry[] = [
  {
    "id": "discord",
    "name": "Discord (Interactions endpoint)",
    "aliases": [
      "discord",
      "discord interactions"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-signature-ed25519",
          "x-signature-timestamp"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "type",
          "application_id",
          "token",
          "id"
        ],
        "optional": [
          "data",
          "guild_id",
          "channel_id",
          "member",
          "user"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "unsupported": {
        "reason": "Discord Interactions đòi trả lời đồng bộ (PING phải trả {type:1}, lệnh phải trả interaction response) và ký Ed25519 bằng khoá công khai — hub chỉ ACK sau COMMIT, không sinh câu trả lời thay ứng dụng.",
        "workaround": "Để ứng dụng Discord của bạn nhận Interactions trực tiếp (trả lời đồng bộ), rồi đẩy sự kiện cần chia sẻ vào hub qua POST /v1/p/:project/events."
      }
    },
    "fields": [],
    "secretSource": null,
    "docs": "https://docs.discord.com/developers/interactions/overview",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://docs.discord.com/developers/interactions/overview"
    ]
  },
  {
    "id": "github",
    "name": "GitHub",
    "aliases": [
      "github",
      "git hub",
      "github.com"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-github-event",
          "x-github-delivery"
        ],
        "optional": [
          "x-hub-signature-256",
          "x-hub-signature",
          "x-github-hook-id",
          "x-github-hook-installation-target-type",
          "x-github-hook-installation-target-id"
        ]
      },
      "userAgent": "^GitHub-Hookshot/",
      "body": {
        "format": [
          "json-object",
          "form"
        ],
        "required": [],
        "optional": [
          "action",
          "repository",
          "sender",
          "installation",
          "organization"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "native": "github"
    },
    "fields": [],
    "secretSource": "provider",
    "docs": "https://docs.github.com/en/webhooks/webhook-events-and-payloads",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://docs.github.com/en/webhooks/webhook-events-and-payloads"
    ]
  },
  {
    "id": "gitlab",
    "name": "GitLab",
    "aliases": [
      "gitlab",
      "git lab"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-gitlab-event"
        ],
        "optional": [
          "x-gitlab-token",
          "x-gitlab-event-uuid",
          "x-gitlab-webhook-uuid",
          "x-gitlab-instance",
          "idempotency-key",
          "webhook-id",
          "webhook-timestamp",
          "webhook-signature"
        ]
      },
      "userAgent": "^GitLab/",
      "body": {
        "format": "json-object",
        "required": [],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "static-token",
        "header": "x-gitlab-token",
        "idempotency": {
          "header": "idempotency-key"
        },
        "eventType": "gitlab.event"
      },
      "alternatives": [
        {
          "note": "GitLab ≥ 19.0 (GA 19.1) có signing token: dùng Standard Webhooks (chữ ký HMAC trên body + webhook-timestamp, an toàn hơn token tĩnh) — nên chọn nếu instance của bạn đủ phiên bản. Bản < 19.0 không gửi webhook-signature nên cách này 401 mãi.",
          "config": {
            "scheme": "standard-webhooks",
            "eventType": "gitlab.event"
          }
        }
      ]
    },
    "fields": [
      {
        "name": "secret",
        "label": "Secret token của webhook GitLab (cần GitLab ≥ 17.4 để có Idempotency-Key; bản cũ hơn không nối được). Nếu chọn Standard Webhooks: signing token (GitLab ≥ 19.0)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://docs.gitlab.com/user/project/integrations/webhooks/",
    "docsVersion": "Secret token + Idempotency-Key: GitLab ≥ 17.4; signing token (Standard Webhooks): GitLab ≥ 19.0 (GA 19.1). Bản < 17.4 không hỗ trợ (thiếu khoá chống trùng).",
    "confidence": "cao",
    "sources": [
      "https://docs.gitlab.com/user/project/integrations/webhooks/",
      "https://docs.gitlab.com/user/project/integrations/webhook_events/"
    ]
  },
  {
    "id": "intercom",
    "name": "Intercom",
    "aliases": [
      "intercom"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-hub-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "type",
          "topic",
          "id",
          "data"
        ],
        "optional": [
          "app_id",
          "created_at",
          "delivery_attempts",
          "first_sent_at",
          "self"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "x-hub-signature",
        "algo": "sha1",
        "encoding": "hex",
        "prefix": "sha1=",
        "idempotency": {
          "field": "id"
        },
        "eventType": "intercom.notification",
        "handshake": {
          "kind": "head-ok"
        }
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "client_secret của app Intercom (Developer Hub → app → Basic Info)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "sha1Reason": "Intercom chỉ ký bằng HMAC-SHA1 (X-Hub-Signature: sha1=<hex 40>, trang Webhook models); hub vẫn so constant-time.",
    "docs": "https://developers.intercom.com/docs/references/webhooks/webhook-models",
    "docsVersion": "Kiểm URL bằng HEAD lúc thêm endpoint (trang Setting up webhooks, đọc 2026-10-14) -> bắt tay head-ok. Chữ ký HMAC-SHA1 hex trên body JSON bằng client_secret, tiền tố sha1=. Khoá chống trùng `id` của notification (\"Intercom defined id representing the notification\"); tài liệu chưa nói rõ giữ nguyên khi gửi lại (có delivery_attempts / first_sent_at) — cùng rủi ro như slack, typeform. Không có cửa sổ thời gian ký.",
    "confidence": "trung bình",
    "sources": [
      "https://developers.intercom.com/docs/references/webhooks/webhook-models",
      "https://developers.intercom.com/docs/webhooks/setting-up-webhooks"
    ]
  },
  {
    "id": "jira",
    "name": "Jira Cloud (Atlassian)",
    "aliases": [
      "jira",
      "jira cloud",
      "atlassian jira"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-atlassian-webhook-identifier"
        ],
        "optional": [
          "x-hub-signature",
          "x-atlassian-webhook-retry",
          "x-atlassian-webhook-flow"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "timestamp",
          "webhookEvent"
        ],
        "optional": [
          "issue_event_type_name",
          "user",
          "issue",
          "changelog",
          "comment"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "x-hub-signature",
        "prefix": "<algo>=",
        "encoding": "hex",
        "idempotency": {
          "header": "x-atlassian-webhook-identifier"
        },
        "eventType": "jira.webhook"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Secret đặt khi tạo webhook Jira",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://developer.atlassian.com/cloud/jira/platform/webhooks/",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://developer.atlassian.com/cloud/jira/platform/webhooks/"
    ]
  },
  {
    "id": "linear",
    "name": "Linear",
    "aliases": [
      "linear",
      "linear.app"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "linear-signature",
          "linear-delivery",
          "linear-event"
        ],
        "optional": [
          "linear-timestamp"
        ]
      },
      "userAgent": "^Linear-Webhook",
      "body": {
        "format": "json-object",
        "required": [
          "action",
          "type",
          "createdAt",
          "webhookTimestamp"
        ],
        "optional": [
          "data",
          "url",
          "actor",
          "updatedFrom",
          "webhookId",
          "organizationId"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "linear-signature",
        "algo": "sha256",
        "encoding": "hex",
        "idempotency": {
          "header": "linear-delivery"
        },
        "eventType": "linear.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Signing secret của webhook Linear",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://linear.app/developers/webhooks",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://linear.app/developers/webhooks"
    ]
  },
  {
    "id": "momo",
    "name": "MoMo",
    "aliases": [
      "momo",
      "ví momo",
      "vi momo",
      "momo ipn"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "partnerCode",
          "orderId",
          "requestId",
          "amount",
          "resultCode",
          "transId",
          "signature"
        ],
        "optional": [
          "orderInfo",
          "orderType",
          "message",
          "payType",
          "responseTime",
          "extraData"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "unverified",
        "idempotency": {
          "field": "transId"
        },
        "eventType": "momo.ipn",
        "ack": {
          "successStatus": 204
        }
      }
    },
    "fields": [],
    "secretSource": null,
    "docs": "https://developers.momo.vn/v3/docs/payment/api/result-handling/notification",
    "docsVersion": "v3. Chữ ký HMAC-SHA256 trên các trường ĐÃ PARSE (S5, accessKey ở cấu hình, không có trong body) -> hub không verify (unverified, PK5): shop tự kiểm `signature` bằng SDK MoMo sau unwrapUnverified. IPN đòi 204 trong 15 giây (đối chiếu 2026-10-14). Khoá chống trùng của hub = transId + băm body (E7); shop chống trùng nghiệp vụ theo transId sau khi verify.",
    "confidence": "cao",
    "sources": [
      "https://developers.momo.vn/v3/docs/payment/api/result-handling/notification",
      "https://developers.momo.vn/v3/docs/payment/api/wallet/onetime"
    ]
  },
  {
    "id": "paddle",
    "name": "Paddle Billing",
    "aliases": [
      "paddle",
      "paddle billing"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "paddle-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "event_id",
          "event_type",
          "occurred_at",
          "data"
        ],
        "optional": [
          "notification_id"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "signed-template",
        "template": "{timestamp}:{body}",
        "signature": {
          "header": "paddle-signature",
          "kv": {
            "sep": ";",
            "sig": "h1",
            "timestamp": "ts"
          }
        },
        "timestampFormat": "unix",
        "toleranceSec": 5,
        "idempotency": {
          "field": "event_id"
        },
        "eventType": "paddle.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Khoá bí mật của notification destination (bắt đầu pdl_ntfset_)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://developer.paddle.com/webhooks/signature-verification",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://developer.paddle.com/webhooks/signature-verification",
      "https://developer.paddle.com/webhooks/overview"
    ]
  },
  {
    "id": "payos",
    "name": "PayOS",
    "aliases": [
      "payos",
      "pay os",
      "payos.vn"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "code",
          "desc",
          "success",
          "data",
          "signature"
        ],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "native": "payos"
    },
    "fields": [],
    "secretSource": "provider",
    "docs": "https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/"
    ]
  },
  {
    "id": "postmark",
    "name": "Postmark",
    "aliases": [
      "postmark"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [],
        "optional": [
          "authorization",
          "x-pm-retries-remaining",
          "x-pm-webhook-trace-id"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "RecordType"
        ],
        "optional": [
          "MessageID",
          "ServerID",
          "MessageStream",
          "Recipient",
          "Tag",
          "Metadata"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "static-token",
        "location": "basic",
        "idempotency": {
          "header": "x-pm-webhook-trace-id"
        },
        "eventType": "postmark.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "user:pass đặt trong URL webhook Postmark (Basic auth)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://postmarkapp.com/developer/webhooks/webhooks-overview",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://postmarkapp.com/developer/webhooks/webhooks-overview"
    ]
  },
  {
    "id": "razorpay",
    "name": "Razorpay",
    "aliases": [
      "razorpay"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-razorpay-signature"
        ],
        "optional": [
          "x-razorpay-event-id"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "x-razorpay-signature",
        "algo": "sha256",
        "encoding": "hex",
        "idempotency": {
          "header": "x-razorpay-event-id"
        },
        "eventType": "razorpay.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Webhook secret đặt khi tạo webhook ở Razorpay Dashboard",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://razorpay.com/docs/webhooks/validate-test/",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://razorpay.com/docs/webhooks/validate-test/"
    ]
  },
  {
    "id": "render",
    "name": "Render",
    "aliases": [
      "render",
      "render.com"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "webhook-id",
          "webhook-timestamp",
          "webhook-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "type",
          "timestamp",
          "data"
        ],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "standard-webhooks",
        "eventType": "render.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Signing secret của webhook Render (whsec_…)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://render.com/docs/webhooks",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://render.com/docs/webhooks"
    ]
  },
  {
    "id": "resend",
    "name": "Resend",
    "aliases": [
      "resend"
    ],
    "group": "svix",
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "svix-id",
          "svix-timestamp",
          "svix-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "standard-webhooks",
        "eventType": "resend.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Signing secret của endpoint (whsec_…)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests"
    ]
  },
  {
    "id": "sepay",
    "name": "SePay",
    "aliases": [
      "sepay",
      "se pay",
      "sepay.vn"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [],
        "optional": [
          "x-sepay-signature",
          "x-sepay-timestamp",
          "authorization"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "id",
          "gateway",
          "transactionDate",
          "accountNumber",
          "transferType",
          "transferAmount",
          "referenceCode"
        ],
        "optional": [
          "code",
          "content",
          "accumulated",
          "subAccount",
          "description"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "native": "sepay"
    },
    "fields": [],
    "secretSource": "provider",
    "docs": "https://developer.sepay.vn/en/sepay-webhooks/xac-thuc",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://docs.sepay.vn/tich-hop-webhooks.html",
      "https://developer.sepay.vn/en/sepay-webhooks/xac-thuc"
    ]
  },
  {
    "id": "shopify",
    "name": "Shopify",
    "aliases": [
      "shopify"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-shopify-hmac-sha256"
        ],
        "optional": [
          "x-shopify-webhook-id",
          "x-shopify-event-id"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "x-shopify-hmac-sha256",
        "algo": "sha256",
        "encoding": "base64",
        "idempotency": {
          "header": "x-shopify-webhook-id"
        },
        "eventType": "shopify.webhook"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Client secret của app Shopify (khoá ký webhook)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://shopify.dev/docs/apps/build/webhooks/subscribe/https",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://shopify.dev/docs/apps/build/webhooks/subscribe/https",
      "https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates"
    ]
  },
  {
    "id": "slack",
    "name": "Slack (Events API)",
    "aliases": [
      "slack",
      "slack events"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-slack-signature",
          "x-slack-request-timestamp"
        ],
        "optional": [
          "x-slack-retry-num",
          "x-slack-retry-reason"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "type"
        ],
        "optional": [
          "token",
          "team_id",
          "api_app_id",
          "event",
          "event_id",
          "event_time",
          "challenge",
          "authorizations"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "signed-template",
        "template": "v0:{timestamp}:{body}",
        "signature": {
          "headers": [
            "x-slack-signature"
          ],
          "prefix": "v0="
        },
        "timestampHeader": "x-slack-request-timestamp",
        "timestampFormat": "unix",
        "toleranceSec": 300,
        "idempotency": {
          "field": "event_id"
        },
        "eventType": "slack.event",
        "handshake": {
          "kind": "body-echo",
          "when": {
            "field": "type",
            "equals": "url_verification"
          },
          "echo": {
            "field": "challenge"
          },
          "afterVerify": true
        }
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Signing Secret của app Slack (api.slack.com/apps → Basic Information → App Credentials)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://docs.slack.dev/authentication/verifying-requests-from-slack",
    "docsVersion": "Chỉ Events API (JSON). Interactivity / slash command gửi form không có event_id -> 422. Bắt tay url_verification: trả challenge dạng text/plain (tài liệu nhận plaintext, form hoặc JSON). event_id \"globally unique\"; tài liệu chưa nói rõ giữ nguyên khi gửi lại (cùng rủi ro như typeform). Request url_verification có ký (tài liệu dặn verify trước khi trả lời) -> afterVerify: chỉ trả challenge khi chữ ký đúng.",
    "confidence": "cao",
    "sources": [
      "https://docs.slack.dev/authentication/verifying-requests-from-slack",
      "https://docs.slack.dev/apis/events-api/",
      "https://docs.slack.dev/reference/events/url_verification"
    ]
  },
  {
    "id": "stripe",
    "name": "Stripe",
    "aliases": [
      "stripe"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "stripe-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "id",
          "object",
          "type",
          "created",
          "data"
        ],
        "optional": [
          "api_version",
          "livemode",
          "pending_webhooks",
          "request",
          "context"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "native": "stripe"
    },
    "fields": [],
    "secretSource": "provider",
    "docs": "https://docs.stripe.com/webhooks",
    "docsVersion": "API 2026-09-30.preview (trang có Thin/Snapshot events)",
    "confidence": "cao",
    "sources": [
      "https://docs.stripe.com/webhooks"
    ]
  },
  {
    "id": "svix",
    "name": "Svix (nền tảng gửi webhook, dùng bởi nhiều SaaS)",
    "aliases": [
      "svix",
      "standard webhooks"
    ],
    "group": "svix",
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "svix-id",
          "svix-timestamp",
          "svix-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "standard-webhooks",
        "eventType": "svix.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Signing secret của endpoint (whsec_…)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://docs.svix.com/receiving/verifying-payloads/how-manual",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://docs.svix.com/receiving/verifying-payloads/how-manual",
      "https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md"
    ]
  },
  {
    "id": "telegram",
    "name": "Telegram Bot API",
    "aliases": [
      "telegram",
      "telegram bot",
      "telegram bot api"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-telegram-bot-api-secret-token"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "update_id"
        ],
        "optional": [
          "message",
          "edited_message",
          "callback_query",
          "channel_post",
          "my_chat_member",
          "chat_member",
          "poll",
          "inline_query"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "static-token",
        "header": "x-telegram-bot-api-secret-token",
        "idempotency": {
          "field": "update_id"
        },
        "eventType": "telegram.update"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "secret_token đã truyền khi gọi setWebhook (1–256 ký tự A-Z a-z 0-9 _ -)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://core.telegram.org/bots/api#setwebhook",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://core.telegram.org/bots/api#setwebhook"
    ]
  },
  {
    "id": "twilio",
    "name": "Twilio",
    "aliases": [
      "twilio"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-twilio-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "form",
        "required": [],
        "optional": [
          "CallSid",
          "From",
          "To"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "unverified",
        "forwardHeaders": [
          "x-twilio-signature"
        ],
        "forwardUrl": true,
        "eventType": "twilio.webhook"
      }
    },
    "fields": [],
    "secretSource": null,
    "docs": "https://www.twilio.com/docs/usage/webhooks/webhooks-security",
    "docsVersion": "X-Twilio-Signature = HMAC-SHA1 (khoá = Auth Token) trên URL đầy đủ + tham số POST sắp a→z (S6) -> hub không verify (unverified + forwardUrl, PK5): shop dùng twilio.validateRequest(authToken, sig, data.url, params từ data.raw). Cần HUB_PUBLIC_URL công khai (không có -> data.url null). Tham số thay đổi theo kênh/sự kiện (tài liệu nói rõ) -> fingerprint body chỉ optional; không khai khoá chống trùng (chỉ băm body, E7). Webhook voice/SMS muốn trả TwiML đồng bộ là S10 — hub chỉ trả 200 rỗng.",
    "confidence": "cao",
    "sources": [
      "https://www.twilio.com/docs/usage/webhooks/webhooks-security"
    ]
  },
  {
    "id": "twitch",
    "name": "Twitch EventSub",
    "aliases": [
      "twitch",
      "eventsub"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "twitch-eventsub-message-id",
          "twitch-eventsub-message-timestamp",
          "twitch-eventsub-message-signature",
          "twitch-eventsub-message-type"
        ],
        "optional": [
          "twitch-eventsub-message-retry",
          "twitch-eventsub-subscription-type",
          "twitch-eventsub-subscription-version"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "subscription"
        ],
        "optional": [
          "event",
          "challenge"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "signed-template",
        "template": "{id}{timestamp}{body}",
        "signature": {
          "headers": [
            "twitch-eventsub-message-signature"
          ],
          "prefix": "sha256="
        },
        "timestampHeader": "twitch-eventsub-message-timestamp",
        "timestampFormat": "iso8601",
        "idHeader": "twitch-eventsub-message-id",
        "toleranceSec": 600,
        "idempotency": {
          "header": "twitch-eventsub-message-id"
        },
        "eventType": "twitch.eventsub",
        "handshake": {
          "kind": "body-echo",
          "when": {
            "header": "twitch-eventsub-message-type",
            "equals": "webhook_callback_verification"
          },
          "echo": {
            "field": "challenge"
          },
          "afterVerify": true
        }
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Secret khai khi tạo subscription EventSub (transport.secret, 10–100 ký tự ASCII)",
        "secret": true
      }
    ],
    "secretSource": "hub",
    "docs": "https://dev.twitch.tv/docs/eventsub/handling-webhook-events/",
    "docsVersion": "Cửa sổ thời gian 10 phút (trang EventSub, mục replay: \"message_timestamp ... isn't older than 10 minutes\", đọc 2026-10-14) -> toleranceSec 600. Gửi lại giữ nguyên message id (cùng trang). Bắt tay webhook_callback_verification: 200 text/plain, challenge thô; request bắt tay có ký -> afterVerify (chỉ trả lời khi chữ ký đúng).",
    "confidence": "cao",
    "sources": [
      "https://dev.twitch.tv/docs/eventsub/handling-webhook-events/",
      "https://dev.twitch.tv/docs/eventsub/"
    ]
  },
  {
    "id": "typeform",
    "name": "Typeform",
    "aliases": [
      "typeform",
      "type form"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "typeform-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "event_id",
          "form_response"
        ],
        "optional": [
          "event_type"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "typeform-signature",
        "prefix": "sha256=",
        "algo": "sha256",
        "encoding": "base64",
        "idempotency": {
          "field": "event_id"
        },
        "eventType": "typeform.webhook"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Secret của webhook Typeform (Connect → Webhooks → Edit → Secret)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
    "docsVersion": "Khoá chống trùng event_id: tài liệu chỉ nói \"Unique ID for the webhook\"; CHƯA có tài liệu xác nhận event_id giữ nguyên khi Typeform gửi lại (review PK9-R2 T-R2-3). Nếu đổi theo lần gửi: hub đã COMMIT mà phản hồi bị mất -> một event trùng.",
    "confidence": "cao",
    "sources": [
      "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
      "https://www.typeform.com/developers/webhooks/example-payload/"
    ]
  },
  {
    "id": "vercel",
    "name": "Vercel",
    "aliases": [
      "vercel",
      "zeit"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-vercel-signature"
        ],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "id",
          "type",
          "createdAt",
          "payload"
        ],
        "optional": [
          "region"
        ]
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "x-vercel-signature",
        "algo": "sha1",
        "encoding": "hex",
        "idempotency": {
          "field": "id"
        },
        "eventType": "vercel.event"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Secret của webhook (tài khoản) hoặc Client Secret của Integration",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "sha1Reason": "Vercel chỉ ký bằng HMAC-SHA1 (tài liệu Webhooks API); hub vẫn so constant-time.",
    "docs": "https://vercel.com/docs/webhooks/webhooks-api",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://vercel.com/docs/webhooks/webhooks-api"
    ]
  },
  {
    "id": "vnpay",
    "name": "VNPay",
    "aliases": [
      "vnpay",
      "vn pay",
      "vnpayment"
    ],
    "group": null,
    "fingerprint": {
      "method": "GET",
      "headers": {
        "required": [],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "empty",
        "required": [],
        "optional": []
      },
      "query": {
        "required": [
          "vnp_TmnCode",
          "vnp_Amount",
          "vnp_TxnRef",
          "vnp_TransactionNo",
          "vnp_ResponseCode",
          "vnp_TransactionStatus",
          "vnp_SecureHash"
        ],
        "optional": [
          "vnp_BankCode",
          "vnp_BankTranNo",
          "vnp_CardType",
          "vnp_PayDate",
          "vnp_OrderInfo",
          "vnp_SecureHashType"
        ]
      }
    },
    "handler": {
      "unsupported": {
        "reason": "VNPay đòi bên nhận trả lời nghiệp vụ đồng bộ (RspCode: đơn có tồn tại, đúng số tiền). Hub không biết đơn hàng (BB-1); trả \"00 Confirm Success\" thay shop là nói dối VNPay.",
        "workaround": "Để shop nhận IPN trực tiếp, xác nhận đơn, rồi đẩy payment.received vào hub qua POST /v1/p/:project/events."
      }
    },
    "fields": [],
    "secretSource": null,
    "docs": "https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html",
    "docsVersion": "2.1.0",
    "confidence": "cao",
    "sources": [
      "https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html"
    ]
  },
  {
    "id": "woocommerce",
    "name": "WooCommerce",
    "aliases": [
      "woocommerce",
      "woo commerce",
      "woo"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [
          "x-wc-webhook-signature"
        ],
        "optional": [
          "x-wc-webhook-source",
          "x-wc-webhook-topic",
          "x-wc-webhook-resource",
          "x-wc-webhook-event",
          "x-wc-webhook-id",
          "x-wc-webhook-delivery-id"
        ]
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "config": {
        "scheme": "hmac",
        "header": "x-wc-webhook-signature",
        "algo": "sha256",
        "encoding": "base64",
        "idempotency": {
          "header": "x-wc-webhook-delivery-id"
        },
        "eventType": "woocommerce.webhook"
      }
    },
    "fields": [
      {
        "name": "secret",
        "label": "Secret đặt khi tạo webhook (WooCommerce → Settings → Advanced → Webhooks)",
        "secret": true
      }
    ],
    "secretSource": "provider",
    "docs": "https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/",
    "docsVersion": "REST API v3",
    "confidence": "trung bình",
    "sources": [
      "https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/",
      "https://hookdeck.com/webhooks/platforms/guide-to-woocommerce-webhooks-features-and-best-practices"
    ]
  },
  {
    "id": "zalopay",
    "name": "ZaloPay",
    "aliases": [
      "zalopay",
      "zalo pay"
    ],
    "group": null,
    "fingerprint": {
      "method": "POST",
      "headers": {
        "required": [],
        "optional": []
      },
      "userAgent": null,
      "body": {
        "format": "json-object",
        "required": [
          "data",
          "mac",
          "type"
        ],
        "optional": []
      },
      "query": {
        "required": [],
        "optional": []
      }
    },
    "handler": {
      "unsupported": {
        "reason": "ZaloPay đòi bên nhận trả lời nghiệp vụ đồng bộ (return_code quyết định ZaloPay có gọi lại không). Hub không biết đơn hàng (BB-1); trả thành công thay shop là nói dối ZaloPay.",
        "workaround": "Để shop nhận IPN trực tiếp, xác nhận đơn, rồi đẩy payment.received vào hub qua POST /v1/p/:project/events."
      }
    },
    "fields": [],
    "secretSource": null,
    "docs": "https://docs.zalopay.vn/docs/developer-tools/knowledge-base/callback/",
    "docsVersion": null,
    "confidence": "cao",
    "sources": [
      "https://docs.zalopay.vn/docs/developer-tools/knowledge-base/callback/"
    ]
  }
];

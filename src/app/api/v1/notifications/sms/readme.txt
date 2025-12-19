/* ==========================================================================  
   BEVGO SMS ENDPOINT — FULL FEATURE BREAKDOWN  
   File: /api/v1/notifications/sms/send/route.js  
   Templates: /api/v1/notifications/sms/messages.js
   --------------------------------------------------------------------------
   This endpoint provides a unified, flexible SMS sending system using  
   SMSPortal. It supports direct messages, template-based messages,  
   variable replacement, and centralised backend template management.
   ==========================================================================

   1) PURPOSE
   -----------------------------------------
   This endpoint allows Bevgo to send SMS messages from the backend.  
   It supports:
      • Simple "send this custom message" mode  
      • Template-based messages (eg: "credit-approved")  
      • Variables injected into templates (eg: OTP codes)  
      • Central backend message registry (no app updates needed)

   The endpoint is designed to be:
      • In-memory (no Firestore indexing required)  
      • Secure (credentials loaded from .env)  
      • Easy to maintain and expand  
      • FlutterFlow-friendly

   ==========================================================================

   2) PAYLOAD OPTIONS (Frontend → Backend)
   -----------------------------------------

   A) **Send a template message**
      {
        "to": "+27831234567",
        "type": "credit-approved"
      }

      → System loads template from messages.js  
      → Message: "Your Bevgo credit application has been approved! 🎉"

   ------------------------------------------------------

   B) **Send a template with variables**
      {
        "to": "+27821234567",
        "type": "otp",
        "variables": {
          "code": "123456"
        }
      }

      Template: "Your one-time login code is: {{code}}"  
      Result:   "Your one-time login code is: 123456"

   ------------------------------------------------------

   C) **Send a fully custom message**
      {
        "to": "+27835556677",
        "message": "Your driver has arrived!"
      }

      → No template required  
      → Raw message sent as-is

   ==========================================================================

   3) TEMPLATE REGISTRY (messages.js)
   -----------------------------------------
   All reusable SMS messages live in:
       /api/v1/notifications/sms/messages.js

   Example:
      smsTemplates = {
        "credit-approved": {
          message: "Your Bevgo credit application has been approved! 🎉"
        },
        "order-dispatched": {
          message: "Your order is on the way! 🚚💨"
        },
        "otp": {
          message: "Your one-time login code is: {{code}}"
        }
      };

   Updating text here instantly updates ALL apps  
   → No mobile/web build needed.

   ==========================================================================

   4) MESSAGE RESOLUTION LOGIC  
   -----------------------------------------

   The endpoint chooses a message based on the following priority:

      1. If "type" is passed → use template  
      2. If "message" is passed → use raw text  
      3. If neither → throw error

   Pseudo:

      if (type provided)
          load template
      else if (message provided)
          use provided message
      else
          error: missing message

   ==========================================================================

   5) VARIABLE REPLACEMENT  
   -----------------------------------------
   Syntax: {{variableName}}

   Example Template:
      "Hello {{name}}, your order {{orderId}} is ready."

   Payload:
      variables: { name: "Dillon", orderId: "INV123" }

   Output:
      "Hello Dillon, your order INV123 is ready."

   ==========================================================================

   6) NUMBER CLEANING  
   -----------------------------------------
   The endpoint automatically strips spaces:
      "+27 83 123 4567" → "+27831234567"

   Only international format is supported:
      Must start with "+"
      Must contain digits only

   ==========================================================================

   7) SMS PORTAL API INTEGRATION  
   -----------------------------------------
   Uses Basic Auth:
      Authorization: Basic base64(CLIENT_ID:API_SECRET)

   Payload follows SMSPortal REST spec:
      {
        "messages": [
          {
            "content": "text here",
            "destinations": [ { "to": "+2783..." } ]
          }
        ]
      }

   ==========================================================================

   8) RESPONSES  
   -----------------------------------------
   SUCCESS:
      {
        ok: true,
        sentAt: "2025-11-25T12:04:01.000Z",
        to: "+27831234567",
        message: "Final message sent",
        providerResponse: { ... }
      }

   ERROR:
      {
        ok: false,
        title: "SMS Sending Failed",
        message: "Provider rejected request",
        providerError: { ... }
      }

   ==========================================================================

   9) FUTURE EXTENSIONS  
   -----------------------------------------
   This endpoint can easily support:

      • Bulk SMS sending  
      • Scheduled messages  
      • Conditional templates  
      • Email/SMS unified notification system  
      • Audit logging to Firestore  
      • Customer-specific message overrides  
      • In-app push notifications with same templates  

   ==========================================================================

   END OF DOCUMENTATION
   ========================================================================== */

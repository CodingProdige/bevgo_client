// ---------------------------------------------------------------------------
// SMS TEMPLATE REGISTRY
// These templates are backend-controlled so the Flutter app never needs updates.
// Each template can support interpolation via {{variable}}.
// ---------------------------------------------------------------------------

export const smsTemplates = {
    "order-dispatched": {
      message: "Your Bevgo order has just been dispatched! 🚚💨 Delivery is on the way."
    },
  
    "order-delivered": {
      message: "Your delivery has been completed! Thank you for choosing Bevgo. 🍻"
    },
  
    "credit-approved": {
      message: "Great news! Your Bevgo credit application has been approved. Your account is now active. 🎉"
    },
  
    "credit-declined": {
      message: "Your Bevgo credit application was not approved. Contact support if you need assistance."
    },
  
    "welcome": {
      message: "Welcome to Bevgo! Your account setup is complete — happy ordering! 🎉"
    },
  
    "otp": {
      message: "Your one-time login code is: {{code}}"
    },
  
    "account-pending-activation": {
      message: "Your Bevgo account is created and pending activation. We'll notify you once it's ready."
    },
  
    "invoice-overdue": {
      message: "Reminder: Your invoice {{invoiceNumber}} is overdue. Please settle to avoid account suspension."
    },
  
    "payment-received": {
      message: "Payment received — thank you! Receipt for {{amount}} has been allocated to your account."
    },
  
    "credit-limit-reached": {
      message: "Your Bevgo credit limit has been reached. Please make a payment to continue ordering."
    }
  };
  
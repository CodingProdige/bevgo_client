export const emailMessages = {
    "welcome": {
      wrapper: "marketing-wrapper.ejs",
      template: "welcome.ejs",
      subjectTemplate: "Welcome to Bevgo, <%= firstName %>!"
    },

    "account-pending": {
        wrapper: "corporate-wrapper.ejs",
        template: "account-pending.ejs",
        subjectTemplate: "Welcome, <%= companyName %>. Your Bevgo Account is Pending Activation"
    },

  
    "credit-approved": {
      wrapper: "corporate-wrapper.ejs",
      template: "credit-approved.ejs",
      subjectTemplate: "Your Bevgo Credit is Approved — Ref <%= code %>"
    },
  
    "credit-rejected": {
      wrapper: "corporate-wrapper.ejs",
      template: "credit-rejected.ejs",
      subjectTemplate: "Your Credit Application Result — Ref <%= code %>"
    },

    "credit-application-submitted": {
      wrapper: "corporate-wrapper.ejs",
      template: "credit-application-submitted.ejs",
      subjectTemplate: "Your Bevgo Credit Application Has Been Received"
    },

    "credit-application-submitted-admin": {
      wrapper: "corporate-wrapper.ejs",
      template: "credit-application-submitted-admin.ejs",
      subjectTemplate: "New Credit Application — <%= companyName %>"
    },
  
    "order-confirmation": {
      wrapper: "corporate-wrapper.ejs",
      template: "order-confirmation.ejs",
      subjectTemplate: "Order <%= orderNumber %> Confirmed"
    },

    "order-processing": {
      wrapper: "corporate-wrapper.ejs",
      template: "order-processing.ejs",
      subjectTemplate: "Order <%= orderNumber || 'your order' %> is Processing"
    },

    "order-dispatched": {
      wrapper: "corporate-wrapper.ejs",
      template: "order-dispatched.ejs",
      subjectTemplate: "Order <%= orderNumber || 'your order' %> Dispatched"
    },

    "payment-received": {
      wrapper: "corporate-wrapper.ejs",
      template: "payment-received.ejs",
      subjectTemplate:
        "Payment received for <%= orderNumber || 'your order' %>"
    },

    "order-received-admin": {
      wrapper: "corporate-wrapper.ejs",
      template: "order-received-admin.ejs",
      subjectTemplate:
        "New order received: <%= orderNumber || merchantTransactionId || 'unknown reference' %>"
    },
  
    "overdue-invoice": {
      wrapper: "corporate-wrapper.ejs",
      template: "overdue-invoice.ejs",
      subjectTemplate: "Invoice <%= invoiceNumber %> is Overdue — <%= daysLate %> Days Late"
    }
  };
  

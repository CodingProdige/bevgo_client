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
  
    "order-confirmation": {
      wrapper: "corporate-wrapper.ejs",
      template: "order-confirmation.ejs",
      subjectTemplate: "Order <%= orderNumber %> Confirmed"
    },
  
    "overdue-invoice": {
      wrapper: "corporate-wrapper.ejs",
      template: "overdue-invoice.ejs",
      subjectTemplate: "Invoice <%= invoiceNumber %> is Overdue — <%= daysLate %> Days Late"
    }
  };
  
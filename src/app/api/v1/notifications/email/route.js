import { NextResponse } from "next/server";
import sgMail from "@sendgrid/mail";
import ejs from "ejs";
import path from "path";
import { emailMessages } from "./messages";

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const ok = (p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err = (s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function resolveNotificationName(input = {}) {
  const snapshot = input?.customer_snapshot || {};
  const account = input?.account || snapshot?.account || {};
  const business = input?.business || snapshot?.business || {};
  const personal = input?.personal || snapshot?.personal || {};

  return firstNonEmptyString(
    account?.accountName,
    business?.companyName,
    personal?.fullName,
    input?.customerName,
    input?.companyName,
    input?.name
  );
}

export async function POST(req){
  try{
    const body = await req.json();
    const { type, to, data } = body;

    if(!type || !to) return err(400,"Missing Fields","type and to are required");

    const config = emailMessages[type];
    if(!config) return err(400,"Unknown Email Type",`No email config for: ${type}`);

    const resolvedName = resolveNotificationName(data || {});
    const safeData = {
      ...(data || {}),
      ...(resolvedName ? {
        name: resolvedName,
        customerName: resolvedName,
        companyName: resolvedName
      } : {})
    };

    const templatePath = path.join(process.cwd(),"src/app/api/v1/notifications/email/templates",config.template);
    const wrapperPath = path.join(process.cwd(),"src/app/api/v1/notifications/email/partials",config.wrapper);

    // Render inner content
    const contentHTML = await ejs.renderFile(templatePath, safeData);

    // Render wrapper with body injected
    const finalHTML = await ejs.renderFile(wrapperPath, {
      body: contentHTML
    });

    // Render subject
    const subject = ejs.render(config.subjectTemplate, safeData);

    const msg = {
      to,
      from: "no-reply@bevgo.co.za",
      subject,
      html: finalHTML
    };

    await sgMail.send(msg);

    return ok({message:"Email sent"});
  }catch(e){
    return err(500,"Email Error",e.message);
  }
}

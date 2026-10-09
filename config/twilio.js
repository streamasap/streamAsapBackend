import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error('Missing Twilio Account SID or Auth Token in environment variables.');
}

// Instantiates and exports the Twilio client using environment variables
const twilioClient = twilio(accountSid, authToken);

export default twilioClient;
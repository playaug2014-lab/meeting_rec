// server/transcriber.js
// Sends audio chunks to OpenAI Whisper for transcription
// Supports English, Hindi, and Hinglish automatically

const FormData = require('form-data');

class Transcriber {
  constructor(language = 'en') {
    // Map our lang codes to Whisper lang codes
    this.language = language === 'hi-IN' ? 'hi' : 'en';
    this.apiKey = process.env.OPENAI_API_KEY;
  }

  async transcribe(audioBuffer) {
    if (!audioBuffer || audioBuffer.length < 1000) return null;

    try {
      // Use OpenAI Whisper API (best for Hindi + English)
      if (this.apiKey) {
        return await this._whisperTranscribe(audioBuffer);
      }
      // Fallback: return placeholder (for testing without API key)
      return { text: '[Audio captured — add OPENAI_API_KEY for transcription]', language: 'en' };
    } catch (err) {
      console.error('[Transcriber] Error:', err.message);
      return null;
    }
  }

  async _whisperTranscribe(audioBuffer) {
    const { default: fetch } = await import('node-fetch');
    const FormDataLib = require('form-data');
    const form = new FormDataLib();

    form.append('file', audioBuffer, {
      filename: 'audio.webm',
      contentType: 'audio/webm'
    });
    form.append('model', 'whisper-1');

    // For Hinglish: don't set language so Whisper auto-detects
    // For pure Hindi: set 'hi', for pure English: set 'en'
    if (this.language !== 'auto') {
      form.append('language', this.language);
    }

    form.append('response_format', 'json');
    form.append('prompt', 'This is a business meeting. Transcribe accurately including Hindi and English words.');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        ...form.getHeaders()
      },
      body: form
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Whisper API error: ${response.status} ${err}`);
    }

    const result = await response.json();
    return {
      text: result.text,
      language: result.language || this.language
    };
  }
}

module.exports = Transcriber;

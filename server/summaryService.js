// server/summaryService.js
// Uses Claude AI to generate structured meeting summaries

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

class SummaryService {
  static async generate(transcript, speakers = []) {
    if (!transcript || transcript.length === 0) {
      return { overview: 'No transcript available.', key_points: [], decisions: [], action_items: [], sentiment: 'neutral' };
    }

    const fullText = transcript.map(e => `${e.speaker} [${e.time}]: ${e.text}`).join('\n');
    const speakerNames = speakers.length > 0 ? speakers.join(', ') : [...new Set(transcript.map(e => e.speaker))].join(', ');
    const wordCount = transcript.reduce((a, e) => a + (e.text?.split(' ').length || 0), 0);
    const duration = transcript.length > 0 ?
      Math.round((transcript[transcript.length - 1].timestamp - transcript[0].timestamp) / 60000) : 0;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a professional meeting analyst. Analyze this meeting transcript and return ONLY a JSON object with no markdown or backticks.

Meeting details:
- Speakers: ${speakerNames}
- Duration: ~${duration} minutes
- Total words: ${wordCount}

Transcript:
${fullText}

Return this exact JSON structure:
{
  "overview": "2-3 sentence summary of the entire meeting",
  "key_points": ["point 1", "point 2", "point 3"],
  "decisions": ["decision made 1", "decision made 2"],
  "action_items": [{"task": "task description", "owner": "person name", "due": "timeline if mentioned"}],
  "sentiment": "positive/neutral/negative",
  "meeting_type": "type of meeting e.g. standup/planning/review",
  "topics": ["topic 1", "topic 2"]
}`
      }]
    });

    const raw = message.content[0]?.text || '{}';
    try {
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return {
        overview: raw,
        key_points: [],
        decisions: [],
        action_items: [],
        sentiment: 'neutral',
        meeting_type: 'Meeting',
        topics: []
      };
    }
  }
}

module.exports = SummaryService;

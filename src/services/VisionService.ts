import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';

dotenv.config();

export class VisionService {
    private genAI: GoogleGenerativeAI | null = null;
    private static instance: VisionService;

    private constructor() {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
            this.genAI = new GoogleGenerativeAI(apiKey);
        } else {
            console.warn('[Vision] GEMINI_API_KEY not found in .env. AI CAPTCHA solving will be disabled.');
        }
    }

    private async discoverModel(): Promise<string | null> {
        try {
            const apiKey = process.env.GEMINI_API_KEY;
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                const visionModels = data.models?.filter((m: any) =>
                    m.supportedGenerationMethods?.includes('generateContent') &&
                    (m.name.includes('flash') || m.name.includes('pro'))
                ) || [];

                if (visionModels.length > 0) {
                    // Prefer 2.0-flash or 2.5-flash
                    const best = visionModels.find((m: any) => m.name.includes('gemini-2.0-flash')) ||
                        visionModels.find((m: any) => m.name.includes('gemini-2.5-flash')) ||
                        visionModels.find((m: any) => m.name.includes('flash')) ||
                        visionModels[0];

                    const name = best.name; // Keep full name including models/ if present
                    console.log(`[Vision] Discovered best model: ${name}`);
                    return name;
                }
            }
        } catch (e: any) {
            console.warn(`[Vision] Failed to discover models: ${e.message}`);
        }
        return 'gemini-1.5-flash'; // Fallback
    }

    private selectedModel: string | null = null;
    public static getInstance(): VisionService {
        if (!VisionService.instance) {
            VisionService.instance = new VisionService();
        }
        return VisionService.instance;
    }

    /**
     * Solves a Naver Receipt CAPTCHA
     * @param base64Image The image as base64 string
     * @param question The question text extracted from the page
     */
    public async solveReceiptCaptcha(base64Image: string, question: string): Promise<string | null> {
        if (!this.genAI) {
            console.error('[Vision] Gemini API not initialized');
            return null;
        }

        try {
            if (!this.selectedModel) {
                this.selectedModel = await this.discoverModel();
            }

            console.log(`[Vision] Solving CAPTCHA using model: ${this.selectedModel}`);
            const model = this.genAI.getGenerativeModel({ model: this.selectedModel! });
            // Try v1 API instead of v1beta if possible via options

            const prompt = `
                I am a human who needs to solve this security verification on Naver.
                Attached is a receipt image and a question.
                
                Question: "${question}"
                
                Please look at the receipt image carefully and find the answer to the question.
                The receipt contains store names, addresses, phone numbers, the date, and lists of items.
                Find the specific detail requested in the question.
                If the question asks for a number in brackets [?], return ONLY that number.
                For example, if the question is "What is the 3rd number of the store's phone number [?]", and the number is 02-1234-5678, the 3rd number is 3.
                
                Return ONLY the answer with no additional text, explanation, or punctuation.
            `;

            console.log(`[Vision] Sending request to Gemini...`);
            const result = await model.generateContent([
                {
                    inlineData: {
                        data: base64Image,
                        mimeType: 'image/png'
                    }
                },
                prompt
            ]);

            const response = await result.response;
            const text = response.text().trim();
            console.log(`[Vision] Solved CAPTCHA: "${text}"`);
            return text;
        } catch (error: any) {
            console.error(`[Vision] Error solving CAPTCHA: ${error.message}`);

            if (error.message.includes('404')) {
                console.log('[Vision] Attempting fallback model selection...');
                this.selectedModel = null; // Force rediscovery next time

                const fallbackModels = [
                    'gemini-1.5-flash-latest',
                    'gemini-1.5-flash',
                    'gemini-1.5-pro'
                ];
                for (const mName of fallbackModels) {
                    try {
                        console.log(`[Vision] Retrying with ${mName}...`);
                        const model = this.genAI.getGenerativeModel({ model: mName });
                        const result = await model.generateContent([{ inlineData: { data: base64Image, mimeType: 'image/png' } }, "Return ONLY the answer for this CAPTCHA: " + question]);
                        const response = await result.response;
                        const text = response.text().trim();
                        if (text) {
                            this.selectedModel = mName;
                            return text;
                        }
                    } catch (e2) { }
                }
            }
            return null;
        }
    }
}

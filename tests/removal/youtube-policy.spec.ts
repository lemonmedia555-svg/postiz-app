import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { YoutubeSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto';
import { YoutubeProvider } from '@gitroom/nestjs-libraries/integrations/social/youtube.provider';

describe('YouTube upload policy', () => {
  test('a separate author acknowledgement is required for each saved upload settings', async () => {
    const settings = { title: 'Test video', type: 'private', selfDeclaredMadeForKids: 'no' };
    expect(await validate(plainToInstance(YoutubeSettingsDto, settings)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ property: 'communityGuidelinesAccepted' })]));
    expect(await validate(plainToInstance(YoutubeSettingsDto, {
      ...settings, communityGuidelinesAccepted: true,
    }))).toEqual([]);
  });

  test('description limit is measured in UTF-8 bytes', () => {
    const provider = new YoutubeProvider();
    expect(provider.validateContent('а'.repeat(2500))).toBeNull();
    expect(provider.validateContent('а'.repeat(2501))).toContain('5,000 bytes');
    expect(provider.validateContent('a'.repeat(5000))).toBeNull();
  });
});

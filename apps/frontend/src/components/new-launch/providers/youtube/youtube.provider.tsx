'use client';

import { FC } from 'react';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { YoutubeSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { Input } from '@gitroom/react/form/input';
import { MediumTags } from '@gitroom/frontend/components/new-launch/providers/medium/medium.tags';
import { MediaComponent } from '@gitroom/frontend/components/media/media.component';
import { Select } from '@gitroom/react/form/select';
import { YoutubePreview } from '@gitroom/frontend/components/new-launch/providers/youtube/youtube.preview';
import { Checkbox } from '@gitroom/react/form/checkbox';
const type = [
  {
    label: 'Public',
    value: 'public',
  },
  {
    label: 'Private',
    value: 'private',
  },
  {
    label: 'Unlisted',
    value: 'unlisted',
  },
];

const madeForKids = [
  {
    label: 'No',
    value: 'no',
  },
  {
    label: 'Yes',
    value: 'yes',
  },
];
const YoutubeSettings: FC = () => {
  const { register, control, formState } = useSettings();
  return (
    <div className="flex flex-col">
      <Input label="Title" {...register('title')} maxLength={100} />
      <p className="mt-[12px] mb-[12px] text-[13px] text-[#B9B9B9]">
        Description: the text in the main post editor is sent to YouTube as the video description. Close Settings to edit it.
      </p>
      <Select
        label="Visibility"
        {...register('type', {
          value: 'private',
        })}
      >
        {type.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <p className="mt-[8px] mb-[12px] text-[13px] text-[#B9B9B9]">
        Until YouTube completes its API audit, videos uploaded through Creatu remain private even if you select Public or Unlisted.
      </p>
      <Select
        label="Made for kids"
        {...register('selfDeclaredMadeForKids', {
          value: 'no',
        })}
      >
        {madeForKids.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <div className="my-[16px] text-[13px]">
        <Checkbox variant="hollow" label="I confirm that this video follows YouTube Community Guidelines"
          {...register('communityGuidelinesAccepted', { value: false })} />
        {formState.errors.communityGuidelinesAccepted && (
          <div className="ml-[34px] text-red-500">Confirm this before publishing or scheduling.</div>
        )}
        <a href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/"
          target="_blank" rel="noopener noreferrer" className="underline ml-[34px]">
          Read YouTube Community Guidelines
        </a>
      </div>
      <MediumTags label="Tags" {...register('tags')} />
      <div className="mt-[20px]">
        <MediaComponent
          type="image"
          width={1280}
          height={720}
          label="Thumbnail"
          description="Thumbnail picture (optional)"
          {...register('thumbnail')}
        />
      </div>
    </div>
  );
};
export default withProvider({
  postComment: PostComment.COMMENT,
  comments: false,
  minimumCharacters: [],
  SettingsComponent: YoutubeSettings,
  CustomPreviewComponent: YoutubePreview,
  dto: YoutubeSettingsDto,
  maximumCharacters: 5000,
});

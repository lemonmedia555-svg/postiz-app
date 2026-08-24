'use client';

import { withContinueProvider } from '../with-continue-provider';

interface VkItem {
  id: string;
  page: string;
  username: string;
  name: string;
  picture: string;
  type: 'profile' | 'community';
}

export const VkContinue = withContinueProvider<VkItem, string>({
  endpoint: 'pages',
  swrKey: 'load-vk-pages',
  titleKey: 'select_vk_page',
  titleDefault: 'Выберите личную страницу или сообщество ВКонтакте:',
  emptyStateMessages: [
    {
      key: 'vk_pages_not_found',
      text: 'Не найдены страницы ВКонтакте, которыми вы можете управлять.',
    },
    {
      key: 'vk_check_permissions',
      text: 'Проверьте права приложения и попробуйте подключиться ещё раз.',
    },
  ],
  getItemId: (item) => item.id,
  getSelectionValue: (item) => item.page,
  transformSaveData: (selection) => ({ page: selection }),
  isSelected: (item, selection) => selection === item.page,
  renderItem: (item) => (
    <>
      <div className="flex justify-center">
        {item.picture ? (
          <img
            className="h-[72px] w-[72px] rounded-full object-cover"
            src={item.picture}
            alt={item.name}
          />
        ) : (
          <div className="h-[72px] w-[72px] rounded-full bg-seventh" />
        )}
      </div>
      <div className="font-medium">{item.name}</div>
      <div className="text-[12px] text-gray-400">
        {item.type === 'community' ? 'Сообщество' : 'Личная страница'}
      </div>
    </>
  ),
});

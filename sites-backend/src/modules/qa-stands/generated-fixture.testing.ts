export const generatedFixture = () => ({
  title: 'Заказы и клиенты',
  entities: [
    {
      id: 'orders',
      title: 'Заказ',
      fields: [
        { name: 'Название', type: 'text', required: true, options: [] },
        { name: 'Сумма', type: 'number', required: true, options: [] },
      ],
    },
    {
      id: 'clients',
      title: 'Клиент',
      fields: [{ name: 'Email', type: 'email', required: true, options: [] }],
    },
  ],
  screens: [
    {
      id: 'orders-list',
      title: 'Заказы',
      kind: 'list',
      entityId: 'orders',
      nextScreenId: 'orders-form',
    },
    {
      id: 'orders-form',
      title: 'Новый заказ',
      kind: 'form',
      entityId: 'orders',
      nextScreenId: 'orders-list',
    },
    {
      id: 'clients-list',
      title: 'Клиенты',
      kind: 'list',
      entityId: 'clients',
      nextScreenId: null,
    },
  ],
  assumptions: ['Оплата моделируется; реальных платежей нет.'],
});

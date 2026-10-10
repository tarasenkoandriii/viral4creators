const {test,expect} = require('@playwright/test');
test.beforeEach(async ({page}) => {await page.goto('/');});
test('login rejects wrong password, preserves demo session and logs out',async({page})=>{
 const form=page.locator('#login-form');
 await form.getByLabel('Email',{exact:true}).fill('demo@example.test');
 await form.getByLabel('Пароль').fill('wrong');await form.getByRole('button',{name:'Войти',exact:true}).click();
 await expect(page.locator('#login-status')).toHaveText('Неверный email или пароль');
 await form.getByLabel('Пароль').fill('SandboxDemo123!');await form.getByRole('button',{name:'Войти',exact:true}).click();
 await expect(page.locator('#cabinet')).toBeVisible();await page.reload();await expect(page.locator('#cabinet')).toBeVisible();
 await page.getByLabel('Уведомления').selectOption('weekly');await page.getByRole('button',{name:'Сохранить настройки'}).click();await page.reload();await expect(page.getByLabel('Уведомления')).toHaveValue('weekly');
 await page.getByRole('button',{name:'Выйти',exact:true}).click();await expect(form).toBeVisible();await expect(page.locator('#cabinet')).toBeHidden();
});
test('required fields block empty request and valid fixture succeeds',async({page})=>{
 const form=page.locator('#request-form');await form.getByRole('button').click();await expect(page.locator('#form-status')).toBeEmpty();
 await form.getByLabel('Имя',{exact:true}).fill('QA Demo');await form.getByLabel('Email для ответа').fill('qa@example.test');await form.getByLabel('Комментарий').fill('Проверка тестовой формы');await form.getByLabel('Я использую вымышленные данные').check();await form.getByRole('button').click();await expect(page.locator('#form-status')).toContainText('Тестовая заявка принята');
});
test('tutorial completes and resets',async({page})=>{await page.getByRole('button',{name:'Следующий шаг'}).click();await expect(page.locator('#tutorial-step')).toContainText('Шаг 2');await page.getByRole('button',{name:'Следующий шаг'}).click();await expect(page.locator('#tutorial-step')).toContainText('обучение завершено');await expect(page.locator('#next-step')).toBeDisabled();await page.getByRole('button',{name:'Начать заново'}).click();await expect(page.locator('#tutorial-step')).toContainText('Шаг 1');});
test('assist service database health',async({request})=>{test.skip(!process.env.ASSIST_API_URL,'Set ASSIST_API_URL to enable external service check');const response=await request.get(process.env.ASSIST_API_URL+'/health');expect(response.status()).toBe(200);expect((await response.json()).data).toMatchObject({status:'ok',database:'up'});});

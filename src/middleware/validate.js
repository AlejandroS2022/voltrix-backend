const { celebrate, Joi, Segments } = require('celebrate');

const validateRegister = celebrate({
  [Segments.BODY]: Joi.object().keys({
    first_name: Joi.string().min(2).max(50).required(),
    last_name: Joi.string().min(2).max(50).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(100).required(),
  }),
});

const validateLogin = celebrate({
  [Segments.BODY]: Joi.object().keys({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),
});

const validateOrder = celebrate({
  [Segments.BODY]: Joi.object().keys({
    side: Joi.string().valid('buy', 'sell').required(),
    order_type: Joi.string().valid('market', 'limit').default('limit'),
    symbol: Joi.string().max(32).default('BTCUSD'),
    // price required for limit orders
    price_cents: Joi.when('order_type', { is: 'limit', then: Joi.number().integer().positive().required(), otherwise: Joi.number().integer().positive().optional() }),
    size: Joi.number().positive().required(),
    stop_loss_cents: Joi.number().integer().positive().optional(),
    take_profit_cents: Joi.number().integer().positive().optional(),
  }),
});

const validateDepositWithdraw = celebrate({
  [Segments.BODY]: Joi.object().keys({
    amount_cents: Joi.number().integer().positive().required(),
  }),
});

module.exports = {
  validateRegister,
  validateLogin,
  validateOrder,
  validateDepositWithdraw,
};

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
    price_cents: Joi.number().integer().positive().required(),
    size: Joi.number().positive().required(),
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

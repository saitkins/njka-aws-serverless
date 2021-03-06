/* eslint-disable no-use-before-define, no-console, import/newline-after-import, consistent-return*/
import axios from 'axios';
import path from 'path';
import uuid from 'uuid';
import moment from 'moment';
import { Promise as bbPromise } from 'bluebird';
import db from '../../connection';
import User from '../user';
import Email from '../email';
import MarketHero from '../marketHero';
import Sagawa from '../sagawa';
import Product from '../product';
import transactionSchema from '../../schemas/transactionSchema';
import {
  handleSquareErrors as HandleSquareErrors,
} from './helpers';
import {
  getMhTransactionTagsMongo as GetMhTransactionTagsMongo,
  getMhTransactionTagsApi as GetMhTransactionTagsApi,
} from '../marketHero/helpers';
import {
  zipArrays as ZipArrays,
} from '../sagawa/helpers';

require('dotenv').config({ path: path.resolve('.dev-server-env'), silent: true });
/**
* Function: "fetchSquareLocation":
* Queries the Square API for the location respective to this application. Once successfully fetched, verifies the location can handle CC processing.  If verified, returns the locationId to the invoking function.
*
* @param {string} country - The country for Square account which the query will be executed..
*
* @return {string} locationId.
*/
transactionSchema.statics.fetchSquareLocation = () =>
new Promise((resolve, reject) => {
  console.log('@fetchSquareLocation');

  axios({
    method: 'get',
    url: 'https://connect.squareup.com/v2/locations',
    headers: { Authorization: `Bearer ${process.env.US_SQUARE_ACCESS_TOKEN}` },
  })
  .then((response) => {
    console.log('\nSUCCEEDED: Fetch Square Location: ', response.data);

    const locations = response.data.locations.filter(({ name }) => name === process.env.US_SQUARE_LOCATION);

    if (locations.length) {
      const newLocation = { ...locations[0] };
      newLocation.error = {
        hard: false,
        soft: false,
        message: '',
      };

      if (newLocation.capabilities.includes('CREDIT_CARD_PROCESSING')) {
        console.log('\nSUCCEEDED: Verify location CC processing.');
        resolve(newLocation);
      } else {
        newLocation.error = {
          hard: true,
          soft: false,
          message: {
            en: `Location "${newLocation.name}" does not have permission "CREDIT_CARD_PROCESSING".`,
            ja: `場所「${newLocation.name}」には「CREDIT_CARD_PROCESSING」の権限がありません。`,
          },
        };
        resolve(newLocation);
      }
    } else {
      console.log('Did not find requested location in Square locations.');
      resolve({
        error: {
          hard: true,
          soft: false,
          message: {
            en: 'Did not find requested lcoation in Square locations.',
            ja: 'スクエアの場所で要求された場所が見つかりませんでした。',
          },
        },
      });
    }
  })
  .catch((error) => {
    console.log('\nFAILED: Fetch square location: ', error);
    reject('\nFAILED: Fetch square location.');
  });
});

/**
* Function: "squareChargeCard":
* Charges the customers credit card using the Square API with the required request body, containing the shipping information associated with the Customer.
*
* @param {object} chargeInfo
*
* @return {object} Square API response.
*/
transactionSchema.statics.squareChargeCard = chargeInfo =>
new Promise((resolve, reject) => {
  console.log('\n\n@Transaction.squareChargeCard\n');

  const {
    userEmail,
    locationId,
    transactionId,
    shippingEmail,
    shippingAddressLine2,
    shippingCity,
    shippingPrefecture,
    shippingPostalCode,
    shippingCountry,
    amount,
    currency,
    cardNonce,
  } = chargeInfo;

  const idempotency_key = uuid(); //eslint-disable-line

  axios.post(
    `https://connect.squareup.com/v2/locations/${locationId}/transactions`,
    {
      idempotency_key,
      buyer_email_address: shippingEmail,
      shipping_address: {
        address_line_1: shippingAddressLine2,
        address_line_2: 'asdf',
        locality: shippingCity,
        administrative_district_level_1: shippingPrefecture,
        postal_code: shippingPostalCode,
        country: shippingCountry,
      },
      amount_money: {
        amount,
        currency,
      },
      card_nonce: cardNonce,
      reference_id: transactionId,
      note: `${userEmail} | Reference #:${transactionId}`,
      delay_capture: false,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.US_SQUARE_ACCESS_TOKEN}`,
      },
    },
  )
  .then((response) => { //eslint-disable-line
    if (response.status !== 200) {
      console.log('\nFAILED: @Transaction.chargeCard >>> axios.post');
      resolve({ status: response.status });
    } else {
      console.log('\nSUCCESS: @Transaction.chargeCard >>> axios.post: ', response.data);

      console.log('amount_money: ', response.data.transaction.tenders[0].amount_money);

      const tender = response.data.transaction.tenders[0];
      return Transaction.findByIdAndUpdate(transactionId, {
        $set: {
          'square.idempotency_key': idempotency_key,
          'square.tender.id': tender.id,
          'square.tender.location_id': tender.location_id,
          'square.tender.transaction_id': tender.transaction_id,
          'square.tender.created_at': tender.created_at,
          'square.tender.note': tender.note,
          'square.tender.amount_money': tender.amount_money,
          'square.tender.type': tender.type,
          'square.tender.card_details.status': tender.card_details.status,
          'square.tender.card_details.card.card_brand': tender.card_details.card.card_brand,
          'square.tender.card_details.entry_method': tender.card_details.entry_method,
        },
      }, { new: true });
    }
  })
  .then((result) => {
    console.log('\nSUCCEEDED: @Square.chargeCard >>> Transaction.findByIdAndUpdate: ', result);
    resolve({ status: 200 });
  })
  .catch((error) => {
    console.log('\nFAILED: @Transaction.squareChargeCard: ', error.response.data.errors);
    reject(`Square Message: ${error.response.data.errors[0].detail}`);
  });
});

/**
* Function: "submitFinalOrder"
* 1. Establishes 3 variables on the highest scope within the function.  These variables will be returned to the client after final promise resolution.
* 2. Call 3 promises in parallel: 1) Create a new Transaction document with values form the input arguments. 2) Find and Update the User document with important email information that may otherwise not already exist.  3) Call the Square API, fetching the business location based on the Billing country (US or Japan) chosen by the customer.
* 3. If successful, assign the upper scopes variables their respective values for Transaction & User.
* 4. Call the Square API again, using the LocationId fetched in the previous step, with any other required info, extracted from the input arguments.
* 5. If successful, update the User document with the necessary transaction history updates. Create or Update the Market Hero document respective to the User document, and generate the required fields for uploading the order information to Sagawa.
* 6. If successful, re-save the upper scope User Doc variable with the updated user information & generate the Invoice Email based on language, and when the order will be shipped to the user.  Save the result on the Transaction document.
* 7. Update the upper scope Transaction Doc variables with the new Transaction information & then call the Sagawa Upload lambda function passing the 1) User Id, 2) Sagawa Id, 3) Transaction Id.
* 8. If order was successfully uploaded to Sagawa, then response status code will be a 200.  The final response will be resolved with the final 1) Transaction document.
*
* @param {object} orderForm - all the inputs from the Order form.
*
* @return {object} Mongo Transaction Document.
*/
transactionSchema.statics.submitFinalOrder = orderForm =>
new Promise((resolve, reject) => {
  console.log('\n\n@Transaction.submitFinalOrder\n');

  console.log('\n1] ARGS: \n', JSON.stringify(orderForm, null, 2));
  let newTransactionDoc = {};
  let userDoc = {};
  let marketHeroOp = '';
  let cartProducts = [];

  const {
    userId,
    language,
    comments,
    termsAgreement,
    newsletterDecision,
    cart,
    sagawa,
    jpyFxRate,
    taxes,
    total,
    square,
  } = orderForm;

  Promise.all([
    bbPromise.fromCallback(cb => Transaction.create({
      comments,
      termsAgreement,
      user: userId,
      products: cart,
      emailLanguage: language,
      emailAddress: sagawa.shippingAddress.email,
      jpyFxRate,
      taxes,
      total,
      square,
      language,
    }, cb)),
    User.findByIdAndUpdate(userId, {
      $set: {
        contactInfo: {
          email: sagawa.shippingAddress.email,
        },
        marketing: {
          newsletterDecision,
        },
      },
    }, { new: true }),
    Transaction.fetchSquareLocation(),
    Product.find({ _id: { $in: cart.map(({ _id }) => _id) } }).exec(),
  ])
  .then((results) => { // eslint-disable-line
    if (!results[0] || !results[1] || !results[2] || !results[3]) {
      resolve({
        error: {
          hard: true,
          soft: false,
          message: {
            en: 'Oops! Looks like we had a Network Error. Our staff has been notified and will provide updates on twitter @NicJuice2Japan. Please try your order again later.',
            ja: 'おっとっと！ ネットワークエラーが発生したようです。 スタッフにお知らせがあり、twitter @ NicJuice2Japanに関する最新情報を提供します。 後でもう一度お試しください。',
          },
        },
        user: null,
        transaction: null,
      });
    } else {
      console.log('\n2] SUCCEEDED: 1) Created new Transaction Document.\n', results[0]._doc, '\n2) Updated User\'s "email" and "marketing" fields.', results[1]._doc, '\n3) Fetched Square Location information.\n', results[2], '\n4) Retrieved Product documents from cart _id\'s.\n', results[3]);

      newTransactionDoc = results[0]._doc;
      userDoc = { ...results[1]._doc };
      cartProducts = ZipArrays(cart, results[3], (cartProduct, dbDoc) =>
      ({ qty: cartProduct.qty, ...dbDoc._doc }));

      return Transaction.squareChargeCard({
        locationId: results[2].id,
        userEmail: userDoc.contactInfo.email,
        transactionId: String(results[0]._id),
        shippingEmail: sagawa.shippingAddress.email,
        shippingAddressLine2: sagawa.shippingAddress.shippingAddressLine2,
        shippingCity: square.shippingAddress.shippingCity,
        shippingPrefecture: square.shippingAddress.shippingPrefecture,
        shippingPostalCode: sagawa.shippingAddress.postalCode,
        shippingCountry: sagawa.shippingAddress.country,
        billingCountry: square.billingCountry,
        amount: square.tender.amount_money.amount,
        currency: square.tender.amount_money.currency,
        cardNonce: square.tender.card_details.card.cardNonce,
        jpyFxRate,
      });
    }
  })
  .then((response) => { //eslint-disable-line
    if (response.status !== 200) {
      resolve({
        error: {
          hard: true,
          soft: false,
          message: HandleSquareErrors(response),
        },
        user: null,
        transaction: null,
      });
    } else {
      console.log('\n3] SUCCEEDED: Square Charge Customer.\n', response.data);
      return Promise.all([
        User.findByIdAndUpdate(userDoc._id, {
          $set: {
            'shopping.transactions': [...userDoc.shopping.transactions, newTransactionDoc._id],
            'shopping.cart': [],
          },
        }, { new: true }),
        MarketHero.checkForLead(sagawa.shippingAddress.email),
        Sagawa.handleNewTransaction({
          cart: cartProducts,
          total,
          userId,
          sagawa,
          transactionId: newTransactionDoc._id,
        }),
      ]);
    }
  })
  .then((results) => { //eslint-disable-line
    if (!results[0] || !results[2]) {
      resolve({
        error: {
          hard: true,
          soft: false,
          message: {
            en: 'Oops! Looks like we had a Network Error. Our staff has been notified and will provide updates on twitter @NicJuice2Japan. Please try your order again later.',
            ja: 'おっとっと！ ネットワークエラーが発生したようです。 スタッフにお知らせがあり、twitter @ NicJuice2Japanに関する最新情報を提供します。 後でもう一度お試しください。',
          },
        },
        user: null,
        transaction: null,
      });
    } else {
      console.log('\n4] SUCCEEDED: 1) Updated User "cart" and "transactions" history.\n', results[0]._doc, '\n 2) Checked for existing Market Hero document.\n', results[1], '\n3) Created Sagawa document for this transaction.\n', results[2]._doc);

      userDoc = { ...results[0]._doc };
      marketHeroOp = results[1] ? 'updateMongoLead' : 'createMongoLead';

      const lead = {
        language,
        email: sagawa.shippingAddress.email,
        givenName: sagawa.shippingAddress.givenName,
        familyName: sagawa.shippingAddress.familyName,
      };

      const mhApiTags = GetMhTransactionTagsApi({
        total,
        language,
        cart: cartProducts,
        subscribed: !!newsletterDecision,
      });

      return Promise.all([
        Email.createInvoiceEmailBody({
          cart: cartProducts,
          square,
          sagawa: results[2]._doc,
          language,
          transaction: newTransactionDoc,
        }, Transaction),
        MarketHero[marketHeroOp]({
          lead,
          tags: GetMhTransactionTagsMongo({
            total,
            language,
            cart: cartProducts,
            subscribed: !!newsletterDecision,
          }),
        }),
        MarketHero.createOrUpdateLead({
          lead,
          userTags: mhApiTags.userTags,
          productTags: mhApiTags.productTags,
        }),
      ]);
    }
  })
  .then((results) => { //eslint-disable-line
    if (!results[0] || !results[1]) {
      resolve({
        error: {
          hard: true,
          soft: false,
          message: {
            en: 'Oops! Looks like we had a Network Error. Our staff has been notified and will provide updates on twitter @NicJuice2Japan. Please try your order again later.',
            ja: 'おっとっと！ ネットワークエラーが発生したようです。 スタッフにお知らせがあり、twitter @ NicJuice2Japanに関する最新情報を提供します。 後でもう一度お試しください。',
          },
        },
        user: null,
        transaction: null,
      });
    } else {
      console.log('\n5] SUCCEEDED: 1) Generate Invoice Email body and insert result into Transaction document.\n', results[0]._id, '\n 2) Create or Update Mongo Market Hero document.\n', results[1], '\n 3) Create or Update Market Hero API lead.\n');

      newTransactionDoc = { ...results[0]._doc };

      const promiseArray = [];
      if (marketHeroOp === 'createMongoLead') {
        promiseArray.push(User.findByIdAndUpdate(userId, {
          $set: { 'marketing.marketHero': results[1]._id },
        }, { new: true }));
      }

      return Promise.all([
        axios.post('http://localhost:3001/api/sagawa/uploadOrderAndSendEmail', {
          password: process.env.TEST_API_PASSWORD,
          userId,
          sagawaId: newTransactionDoc.sagawa,
          transactionId: newTransactionDoc._id,
        }),
        ...promiseArray,
      ]);
    }
  })
  .then((results) => { //eslint-disable-line
    console.log('\nSAGAWA UPLOAD results: ', results);
    if (results[0].status !== 200) {
      resolve({
        error: {
          hard: true,
          soft: false,
          message: {
            en: 'Oops! Looks like we had a Network Error. Our staff has been notified and will provide updates on twitter @NicJuice2Japan. Please try your order again later.',
            ja: 'おっとっと！ ネットワークエラーが発生したようです。 スタッフにお知らせがあり、twitter @ NicJuice2Japanに関する最新情報を提供します。 後でもう一度お試しください。',
          },
        },
        user: null,
        transaction: null,
      });
    } else {
      console.log('\n6] SUCCEEDED: 1) Call Sagawa Order Upload lambda.', results[0].status, '\n2) Update User Document with new MarketHero Doc _id (if necessary).', results[1]);

      if (results.length === 2) userDoc = results[1];

      cartProducts.forEach((productDoc) => {
        const {
          _id,
          statistics,
        } = productDoc;

        Product.findByIdAndUpdate(_id, {
          $inc: {
            'product.quantities.inCarts': -1,
            'product.quantities.purchased': 1,
            'statistics.completedCheckouts': 1,
          },
          $set: {
            'statistics.transactions': [...statistics.transactions, {
              transactionId: newTransactionDoc._id,
              userId,
            }],
          },
        }, { new: true })
        .then((savedDoc) => {
          console.log('\n7] SUCCEEDED: Update "statistics" & "quantities" keys for product: ', `${savedDoc.product.flavor}_${savedDoc.product.nicotineStrength}mg`);
        })
        .catch((error) => {
          console.log('\nFAILED: Update "statistics" & "quantities" keys for product: ', `${productDoc.product.flavor}_${productDoc.product.nicotineStrength}mg`, '. Error: ', error);
          reject(new Error('\nFAILED: Update "statistics" & "quantities" keys for product: ', `${productDoc.product.flavor}_${productDoc.product.nicotineStrength}mg`));
        });
      });

      console.log('\n8] Order complete! Resolving with 1) User doc, 2) Transaction doc.');
      resolve({
        error: {
          hard: false,
          soft: false,
          message: {
            en: '',
            ja: '',
          },
        },
        user: userDoc,
        transaction: newTransactionDoc,
      });
    }
  })
  .catch((error) => {
    console.log('\nFAILED to submit order due to error: ', error);
    resolve({
      error: {
        hard: true,
        soft: false,
        message: {
          en: 'Oops! Looks like we had a Network Error. Our staff has been notified and will provide updates on twitter @NicJuice2Japan. Please try your order again later.',
          ja: 'おっとっと！ ネットワークエラーが発生したようです。 スタッフにお知らせがあり、twitter @ NicJuice2Japanに関する最新情報を提供します。 後でもう一度お試しください。',
        },
      },
      user: null,
      transaction: null,
    });
  });
});

transactionSchema.statics.issueUserRefund = ({ sagawaId, transactionId, userId }) =>
new Promise((resolve, reject) => {
  console.log('\n\n@Transaction.issueUserRefund');

  Transaction
  .findById(transactionId)
  .then((dbTransaction) => {
    if (!dbTransaction) {
      console.log('FAILED: @Transaction.issueUserRefund >>> Transaction.findById: ', transactionId);
      reject({
        type: 'RefundNotSent',
        message: 'The transaction id provided was not found in DB.',
      });
    } else {
      return axios.post(`https://connect.squareup.com/v2/locations/${dbTransaction.square.tender.location_id}/transactions/${dbTransaction.square.tender.transaction_id}/refund`, {
        idempotency_key: dbTransaction.square.idempotency_key,
        tender_id: dbTransaction.square.tender.id,
        reason: 'There was an issue during checkout after your card was charged.',
        amount_money: {
          amount: dbTransaction.square.tender.amount_money.amount,
          currency: dbTransaction.square.tender.amount_money.currency,
        },
      }, {
        headers: {
          Authorization: `Bearer ${process.env.US_SQUARE_ACCESS_TOKEN}`,
        },
      });
    }
  })
  .then((response) => { //eslint-disable-line
    if (response.status !== 200) {
      console.log('\nFAILED: Transaction.issueUserRefund >>> axios.post: ', response.data);
      reject({
        type: 'RefundNotSent',
        message: `axios.post to Sagawa API responded with status code "${response.status}"`,
      });
    } else {
      console.log('\nSUCCEEDED: Transaction.issueUserRefund >>> axios.post: ', response.data.refund);

      return Promise.all([
        Transaction.findByIdAndUpdate(transactionId, {
          $set: {
            'square.refund': response.data.refund,
          },
        }, { new: true }),
        Email.refundNotification({
          userId,
          sagawaId,
          transactionId,
          message: {
            user: {
              subject: 'Shipping Problem - You have been issued a refund.',
              replyTo: 'NJ2JP Sales <sales@nj2jp.com>',
              body: `
              ${moment().format('ll')}

              Dear USER_NAME_HERE,

              While we were submitting your most recent order for shipment we had a network error.  This network error occured after you had already been charged for your order.

              Due to this fact, we've issued you a refund for the total amount of the order:

              CURRENCY_TYPE_HERE REFUND_AMOUNT_HERE

              The refund has been credited to your credit card:

              XXXX - XXXX - XXXX - LAST_4_HERE

              We understand this is a major inconvenience and a waste of your valuable shopping time and we apologize.  We will be in contact with you about placing a re-order once we're confident the issue has been resolved.

              If you would like to stay current with our troubleshooting efforts you can follow us on twitter @NicJuice2Japan.  Our developers will provide updates here regularly as we learn more.

              Sincerely,

              NJ2JP Team

              `,
            },
            staff: {
              subject: `ERROR 🛑 User: "${userId}" - Order failed to upload to sagawa during Cron Job.`,
              replyTo: 'NJ2JP Cron Job - No Reply <admin@nj2jp.com>',
              body: `
              ${moment().format('llll')}

              There has been a critical error while trying to upload an order to Sagawa for User #: ${userId}.  The user has successfully been issued a full refund.

              1) The user has been issued a refund:
              - Last 4: LAST_4_HERE
              - User Email: USER_EMAIL_HERE
              - User Name: USER_NAME_HERE
              - Reference #: REFERENCE_ID_HERE

              2) You can view the Cloud Watch logs here: https://ap-northeast-1.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1#logStream:group=%252Faws%252Flambda%252Fnj2jp-development-sagawa .
              `,
            },
          },
        }),
      ]);
    }
  })
  .then((results) => {
    console.log('\nTransaction.issueUserRefund >>> 1) Transaction.findByIdAndUpdate', results[0].square.refund, '\n2) Email.sendRefundEmailAndSlack: ', results[1]);
    resolve();
  })
  .catch((error) => {
    console.log('\nFAILED: Transaction.issueUserRefund: ', error);
    reject(error);
  });
});

transactionSchema.statics.handleRefund = ({ sagawaId, transactionId, userId }) =>
new Promise((resolve, reject) => {
  console.log('\n\n@Transaction.handleRefund');

  if (!userId || !transactionId) {
    console.log('\nFAILED: Missing required arguments.');
    reject('\nFAILED: Missing required arguments.');
  } else {
    Transaction
    .issueUserRefund({ sagawaId, transactionId, userId })
    .then(() => {
      resolve({
        userId,
        transactionId,
        verified: false,
      });
    })
    .catch((error) => {
      if (!!error.type) {
        if (error.type === 'RefundNotSent') {
          console.log('\nFAILED: Sagawa.uploadOrderAndSendEmail >>> Transaction.issueUserRefund: ', error.message);
          return Email.refundNotification({
            userId,
            sagawaId,
            transactionId,
            message: {
              user: {
                subject: 'Shippping Problem',
                replyTo: 'NJ2JP Sales <sales@nj2jp.com>',
                body: `
                ${moment().format('ll')} -
                Dear USER_NAME_HERE,

                While we were submitting your most recent order for shipment we had a network error.  This network error occured after you had already been charged for your order.

                Due to this fact, we will be issuing a refund for the total amount of the order:

                CURRENCY_TYPE_HERE REFUND_AMOUNT_HERE

                The refund will be credited to your credit card:

                XXXX - XXXX - XXXX - LAST_4_HERE

                We understand this is a major inconvenience and a waste of your valuable shopping time and we apologize.  We will be in contact with you about placing a re-order once we're confident the issue has been resolved.

                If you would like to stay current with our troubleshooting efforts you can follow us on twitter @NicJuice2Japan.  Our developers will provide updates here regularly as we learn more.

                Sincerely,

                NJ2JP Team

                `,
              },
              staff: {
                subject: `ERROR 🛑  User: "${userId}" - Order failed to upload to sagawa during Cron Job.`,
                replyTo: 'NJ2JP Cron Job <admin@nj2jp.com>',
                body: `
                ${moment().format('llll')}

                There has been a CRITICAL error while trying to upload an order to Sagawa for User #: ${userId}.

                The Users's upload was not successful and the attempt to issue the User an automatic refund was also NOT sucessful.

                You must login to Square and use the transaction information shown below to issue the customer and IMMEDIATE REFUND.

                1) The User must be issued a manual refund ASAP.
                - Last 4: LAST_4_HERE
                - User Email: USER_EMAIL_HERE
                - User Name: USER_NAME_HERE
                - Reference #: REFERENCE_ID_HERE

                2) Review Cloud watch report here: https://ap-northeast-1.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-1#logStream:group=%252Faws%252Flambda%252Fnj2jp-development-sagawa.

                Customer has been issued a full refund.`,
              },
            },
          });
        }
      } else {
        console.log('\nFAILED: Transaction.handleRefund >>> Email.sendPendingRefundEmailAndSlack: ', error);
        reject(error);
      }
    })
    .then(() => {
      console.log('\nSUCCEEDED: Transaction.handleRefund >>> Email.sendPendingRefundEmailAndSlack');
      resolve({
        userId,
        transactionId,
        verified: false,
      });
    })
    .catch((error) => {
      console.log('\nFAILED: Transaction.handleRefund: ', error);
      reject(error);
    });
  }
});

const Transaction = db.model('Transaction', transactionSchema);
export default Transaction;
